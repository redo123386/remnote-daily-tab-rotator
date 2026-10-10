import {
  AppEvents,
  BuiltInPowerupCodes,
  declareIndexPlugin,
  type ReactRNPlugin,
  type RemIdWindowTree,
} from '@remnote/plugin-sdk';
import { dayKey, detectTitleFormat, effectiveDate, msUntilNextBoundary, parseDayStart, pastTitles } from '../lib/dates';
import { leaves, type InPlaceHost, type InPlaceState, type PaneLeaf, type Tree } from '../lib/inPlace';
import { rotate, type RotationHost, type RotationReport } from '../lib/rotation';
import { TabDriver, norm, waitFor } from '../lib/tabDriver';

const S = {
  enabled: 'enabled',
  switchToToday: 'switch-to-today',
  dayStart: 'day-start-time',
  lockLabel: 'lock-label',
  unlockLabel: 'unlock-label',
  tabSelector: 'tab-selector',
  debug: 'debug',
} as const;

const STORE_LAST_DAY = 'lastRotatedDay';
const STORE_IN_PLACE = 'inPlaceState';
const CHECK_EVERY_MS = 30_000;
const RETRY_AFTER_MS = 2 * 60_000;
const MAX_ATTEMPTS_PER_DAY = 4;
const LOOKBACK_DAYS = 31;

// Module state, reset on deactivate.
let intervalId: ReturnType<typeof setInterval> | undefined;
let boundaryId: ReturnType<typeof setTimeout> | undefined;
let removeListeners: (() => void) | undefined;
let running = false;
let attempts = { day: '', count: 0, lastAt: 0, warned: false };
let todayCache: { key: string; id: string; title: string } | undefined;

const splitLabels = (s: string | undefined, fallback: string) =>
  (s && s.trim() ? s : fallback).split(',').map((x) => x.trim()).filter(Boolean);

/**
 * The document that holds RemNote's UI. A native plugin runs in RemNote's own page; a sandboxed
 * one runs in an iframe that cannot reach it, in which case this returns undefined.
 */
function hostDocument(): Document | undefined {
  return findHost().doc;
}

/**
 * Native plugins run in RemNote's own window; sandboxed ones in a cross-origin iframe that
 * serves the plugin's index.html. Rather than rely on RemNote class names (which change), check
 * where we are running and whether that page is RemNote's app rather than our own stub page.
 */
function findHost(): { doc?: Document; detail: string } {
  const isOwnStubPage = (d: Document) =>
    /:8080$/.test(d.location?.host ?? '') || (d.body?.getElementsByTagName('*').length ?? 0) < 40;
  const inIframe = (() => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  })();
  const candidates: Document[] = [document];
  for (const w of [window.parent, window.top]) {
    try {
      if (w && w !== window && w.document) candidates.push(w.document);
    } catch {
      /* cross-origin parent: this is the sandbox */
    }
  }
  const doc = candidates.find((d) => !isOwnStubPage(d));
  const detail =
    `running ${inIframe ? 'inside an iframe' : 'in the main window'} at ${location.host || location.protocol}` +
    `, ${candidates.length} reachable page(s)`;
  return { doc, detail };
}

async function getSettings(plugin: ReactRNPlugin) {
  const g = <T,>(id: string) => plugin.settings.getSetting<T>(id);
  return {
    enabled: (await g<boolean>(S.enabled)) ?? true,
    switchToToday: (await g<boolean>(S.switchToToday)) ?? true,
    dayStartMinutes: parseDayStart(await g<string>(S.dayStart)) ?? 0,
    lockLabels: splitLabels(await g<string>(S.lockLabel), 'Lock Tab'),
    unlockLabels: splitLabels(await g<string>(S.unlockLabel), 'Unlock Tab'),
    tabSelector: ((await g<string>(S.tabSelector)) ?? '').trim(),
    debug: (await g<boolean>(S.debug)) ?? false,
  };
}

type Settings = Awaited<ReturnType<typeof getSettings>>;

function makeLogger(debug: boolean) {
  return (...a: unknown[]) => {
    if (debug) console.log('[Daily Tab Rotator]', ...a);
  };
}

function makeDriver(doc: Document, s: Settings) {
  return new TabDriver(doc, {
    tabSelector: s.tabSelector || undefined,
    lockLabels: s.lockLabels,
    unlockLabels: s.unlockLabels,
    log: makeLogger(s.debug),
  });
}

/** RotationHost backed by the RemNote plugin SDK. */
function makeHost(plugin: ReactRNPlugin, s: Settings): RotationHost {
  let todayRem: Awaited<ReturnType<typeof plugin.date.getDailyDoc>>;
  const resolved = new Map<string, string | undefined>();
  const log = makeLogger(s.debug);

  const ensureToday = async () => {
    if (todayRem) return todayRem;
    const date = effectiveDate(new Date(), s.dayStartMinutes);
    todayRem = await plugin.date.getDailyDoc(date);
    if (!todayRem) throw new Error("RemNote didn't return a daily document for today.");
    return todayRem;
  };

  return {
    log,
    async getToday() {
      const rem = await ensureToday();
      const title = norm(rem.text ? await plugin.richText.toString(rem.text) : '');
      if (!title) throw new Error("Today's daily document has no title.");
      return { id: rem._id, title, date: effectiveDate(new Date(), s.dayStartMinutes) };
    },
    async resolveDailyDoc(title) {
      if (resolved.has(title)) return resolved.get(title);
      const parentId = (await ensureToday()).parent;
      const rt = await plugin.richText.text(title).value();
      let id: string | undefined;
      // findByName only looks up; unlike getDailyDoc it never creates a document.
      const rem = await plugin.rem.findByName(rt, parentId ?? null);
      if (rem && (await rem.hasPowerup(BuiltInPowerupCodes.DailyDocument))) id = rem._id;
      resolved.set(title, id);
      return id;
    },
    async openToday() {
      await plugin.window.openRem(await ensureToday());
    },
    async openPaneRemIds() {
      return (await plugin.window.getOpenPaneRemIds()) ?? [];
    },
  };
}

function summarize(r: RotationReport): string {
  if (!r.ok) return `Daily tab: ${r.errors.join(' ')}`;
  const parts: string[] = [];
  if (r.openedToday) parts.push(`opened ${r.today}`);
  if (!r.alreadyLocked) parts.push(`locked ${r.today}`);
  if (r.unlocked.length) parts.push(`unlocked ${r.unlocked.join(', ')}`);
  return parts.length ? `Daily tab: ${parts.join('; ')}.` : `Daily tab: ${r.today} is already locked.`;
}

/** InPlaceHost backed by the plugin SDK (works in sandboxed mode). */
function makeInPlaceHost(plugin: ReactRNPlugin, s: Settings): InPlaceHost {
  const date = effectiveDate(new Date(), s.dayStartMinutes);
  const key = dayKey(date);
  return {
    log: makeLogger(s.debug),
    async getToday() {
      if (todayCache?.key === key) return todayCache;
      const rem = await plugin.date.getDailyDoc(date);
      if (!rem) throw new Error("RemNote didn't return a daily document for today.");
      const title = norm(rem.text ? await plugin.richText.toString(rem.text) : '');
      todayCache = { key, id: rem._id, title };
      return todayCache;
    },
    getTree: async () => (await plugin.window.getCurrentWindowTree()) as Tree<PaneLeaf> | undefined,
    setTree: (tree) => plugin.window.setRemWindowTree(tree as RemIdWindowTree),
    async isDailyDoc(remId) {
      const rem = await plugin.rem.findOne(remId);
      return !!rem && (await rem.hasPowerup(BuiltInPowerupCodes.DailyDocument));
    },
    load: () => plugin.storage.getLocal<InPlaceState>(STORE_IN_PLACE),
    save: (st) => plugin.storage.setLocal(STORE_IN_PLACE, st),
  };
}

async function runRotation(plugin: ReactRNPlugin, reason: string, force: boolean): Promise<void> {
  if (running) return;
  const s = await getSettings(plugin);
  const log = makeLogger(s.debug);
  if (!s.enabled && !force) return;

  // Without native mode the tab bar is out of reach; use the sandbox-safe in-place swap.
  const host = findHost();
  const doc = host.doc;
  if (!doc) {
    // Sandboxed plugins can't lock tabs, and RemNote opens a new tab rather than let them change a
    // locked one, so there is nothing safe to do automatically.
    log(`Skipped (${reason}): sandboxed, ${host.detail}`);
    if (force) {
      await plugin.app.toast(
        "Daily Tab Rotator needs Native mode to lock tabs. RemNote has it switched off for this plugin, so it won't change any tabs.",
      );
    }
    return;
  }

  const key = dayKey(effectiveDate(new Date(), s.dayStartMinutes));
  if (!force) {
    const last = await plugin.storage.getLocal<string>(STORE_LAST_DAY);
    if (last === key) return;
    if (attempts.day !== key) attempts = { day: key, count: 0, lastAt: 0, warned: false };
    if (attempts.count >= MAX_ATTEMPTS_PER_DAY) return;
    if (Date.now() - attempts.lastAt < RETRY_AFTER_MS) return;
  }
  // Wait until the window is visible; a visibility change will trigger us again.
  if (doc.hidden && !force) return;

  running = true;
  attempts.count++;
  attempts.lastAt = Date.now();
  try {
    log(`Rotating (${reason}) for ${key}`);
    const report = await rotate(makeDriver(doc, s), makeHost(plugin, s), {
      switchToToday: s.switchToToday,
      lookbackDays: LOOKBACK_DAYS,
    });
    log('Report', report);
    if (report.ok) {
      await plugin.storage.setLocal(STORE_LAST_DAY, key);
      if (force || report.openedToday || !report.alreadyLocked || report.unlocked.length) {
        await plugin.app.toast(summarize(report));
      }
    } else if (force || (attempts.count >= MAX_ATTEMPTS_PER_DAY && !attempts.warned)) {
      attempts.warned = true;
      await plugin.app.toast(
        `${summarize(report)} Run "Daily Tab: Diagnose" from the command palette for details.`,
      );
    }
  } catch (e) {
    console.error('[Daily Tab Rotator]', e);
    if (force) await plugin.app.toast(`Daily tab rotation failed: ${String(e)}`);
  } finally {
    running = false;
  }
}

async function diagnose(plugin: ReactRNPlugin) {
  const s = await getSettings(plugin);
  const host = findHost();
  const doc = host.doc;
  const out: Record<string, unknown> = {
    sdk: '@remnote/plugin-sdk',
    nativeAccess: !!doc,
    environment: host.detail,
    settings: s,
    lastRotatedDay: await plugin.storage.getLocal<string>(STORE_LAST_DAY),
  };
  if (doc) {
    const driver = makeDriver(doc, s);
    const host = makeHost(plugin, s);
    const today = await host.getToday();
    const format = detectTitleFormat(today.date, today.title);
    out.today = today.title;
    out.detectedTitleFormat = format ?? null;
    out.tabCandidates = driver.describeCandidates();
    const titles = new Set(driver.listTabCandidates().map((c) => c.title));
    if (format) for (const t of pastTitles(today.date, format, LOOKBACK_DAYS)) {
      if (driver.findByTitle(t).length) titles.add(t);
    }
    titles.add(today.title);
    const daily: unknown[] = [];
    for (const title of titles) {
      const remId = title === today.title ? today.id : await host.resolveDailyDoc(title);
      if (!remId) continue;
      let state: string = 'not a tab';
      for (const el of driver.findByTitle(title)) {
        const st = await driver.probe(el);
        if (st) { state = st; break; }
      }
      daily.push({ title, remId, isToday: title === today.title, state });
    }
    out.dailyNoteTabs = daily;
  } else {
    const ip = makeInPlaceHost(plugin, s);
    const today = await ip.getToday();
    const tree = await ip.getTree();
    const panes = tree ? leaves(tree) : [];
    out.mode = 'sandboxed: cannot lock tabs (needs Native mode)';
    out.today = today;
    out.inPlaceState = (await ip.load()) ?? null;
    out.currentTabPanes = await Promise.all(
      panes.map(async (p) => ({ ...p, isDailyDoc: await ip.isDailyDoc(p.remId), isToday: p.remId === today.id })),
    );
  }
  const json = JSON.stringify(out, null, 2);
  console.log('[Daily Tab Rotator] Diagnose\n' + json);
  let copied = false;
  try {
    await navigator.clipboard.writeText(json);
    copied = true;
  } catch {
    /* clipboard may be unavailable */
  }
  const dailyTabs = (out.dailyNoteTabs as { isToday: boolean; state: string }[] | undefined) ?? [];
  const todayState = dailyTabs.find((d) => d.isToday)?.state ?? 'not open';
  await plugin.app.toast(
    doc
      ? `Found ${(out.tabCandidates as unknown[]).length} tab candidate(s); today's tab: ${todayState}. ` +
        (copied ? 'Full report copied to clipboard.' : 'Full report is in the developer console.')
      : `Sandboxed mode: can't lock tabs until Native mode is on. This tab ` +
        ((out.currentTabPanes as { isToday: boolean; isDailyDoc: boolean }[]).some((p) => p.isToday)
          ? "shows today's note. "
          : (out.currentTabPanes as { isDailyDoc: boolean }[]).some((p) => p.isDailyDoc)
            ? 'shows a past daily note. '
            : "isn't a daily note. ") +
        (copied ? 'Full report copied to clipboard.' : 'Full report is in the developer console.'),
  );
}

async function onActivate(plugin: ReactRNPlugin) {
  await plugin.settings.registerBooleanSetting({
    id: S.enabled,
    title: 'Rotate the locked daily-note tab automatically',
    description:
      "Each day, open and lock today's daily note and unlock previous days' daily-note tabs. " +
      'Requires Native mode (switch above).',
    defaultValue: true,
  });
  await plugin.settings.registerBooleanSetting({
    id: S.switchToToday,
    title: "Switch to today's tab after rotating (Native mode only)",
    defaultValue: true,
  });
  await plugin.settings.registerStringSetting({
    id: S.dayStart,
    title: 'Day starts at (HH:MM, 24-hour)',
    description:
      "When the lock moves to the new day's note. Use 04:30 to keep the previous day locked until 4:30am. " +
      'An invalid time counts as 00:00.',
    defaultValue: '00:00',
  });
  await plugin.settings.registerStringSetting({
    id: S.lockLabel,
    title: 'Tab menu label for locking (Native mode only)',
    description: 'Exact text of the tab right-click menu item. Separate alternatives with commas.',
    defaultValue: 'Lock Tab',
  });
  await plugin.settings.registerStringSetting({
    id: S.unlockLabel,
    title: 'Tab menu label for unlocking (Native mode only)',
    description: 'Exact text of the tab right-click menu item. Separate alternatives with commas.',
    defaultValue: 'Unlock Tab',
  });
  await plugin.settings.registerStringSetting({
    id: S.tabSelector,
    title: 'Advanced: CSS selector for one tab (Native mode only)',
    description: 'Leave empty. Only set this if "Daily Tab: Diagnose" shows tabs are not being found.',
    defaultValue: '',
  });
  await plugin.settings.registerBooleanSetting({
    id: S.debug,
    title: 'Log details to the developer console',
    defaultValue: false,
  });

  await plugin.app.registerCommand({
    id: 'daily-tab-rotate-now',
    name: 'Daily Tab: Switch to today’s note now',
    action: async () => {
      await runRotation(plugin, 'command', true);
    },
  });
  await plugin.app.registerCommand({
    id: 'daily-tab-diagnose',
    name: 'Daily Tab: Diagnose',
    action: async () => {
      await diagnose(plugin);
    },
  });

  // Day-change detection: a periodic check, a timer at the boundary, and window wake-ups
  // (sleep/resume and minimised windows can delay timers past midnight).
  intervalId = setInterval(() => void runRotation(plugin, 'interval', false), CHECK_EVERY_MS);

  const armBoundary = async () => {
    const { dayStartMinutes } = await getSettings(plugin);
    boundaryId = setTimeout(async () => {
      await runRotation(plugin, 'day boundary', false);
      void armBoundary();
    }, msUntilNextBoundary(new Date(), dayStartMinutes));
  };
  void armBoundary();

  const win = hostDocument()?.defaultView ?? window;
  const onWake = () => void runRotation(plugin, 'window focus', false);
  const onVis = () => {
    if (!win.document.hidden) onWake();
  };
  win.addEventListener('focus', onWake);
  win.document.addEventListener('visibilitychange', onVis);
  // Switching tabs or opening a document: lets the sandboxed swap happen as soon as the locked
  // daily tab comes into view.
  const onNavigate = () => void runRotation(plugin, 'tab change', false);
  const navEvents = [AppEvents.CurrentWindowTreeChange, AppEvents.FocusedPaneChange, AppEvents.URLChange];
  for (const ev of navEvents) plugin.event.addListener(ev, undefined, onNavigate);

  removeListeners = () => {
    win.removeEventListener('focus', onWake);
    win.document.removeEventListener('visibilitychange', onVis);
    for (const ev of navEvents) plugin.event.removeListener(ev, undefined, onNavigate);
  };

  // Startup: let RemNote sync and draw its tab bar, then rotate once if today isn't done yet.
  // Runs in the background: RemNote treats the plugin as still loading (settings hidden, Native
  // mode switch disabled) until onActivate returns, so onActivate must not wait on anything slow.
  void (async () => {
    try {
      await Promise.race([plugin.app.waitForInitialSync(), new Promise((r) => setTimeout(r, 15_000))]);
      const doc = hostDocument();
      if (doc) {
        const s = await getSettings(plugin);
        await waitFor(() => makeDriver(doc, s).listTabCandidates().length > 0 || undefined, 15_000, 250);
      } else if ((await getSettings(plugin)).enabled) {
        await plugin.app.toast(
          'Daily Tab Rotator is off until you turn on Native mode: Settings → Plugins → Daily Tab Rotator, then reload.',
        );
      }
      await runRotation(plugin, 'startup', false);
    } catch (e) {
      console.error('[Daily Tab Rotator] startup', e);
    }
  })();
}

async function onDeactivate(_: ReactRNPlugin) {
  if (intervalId) clearInterval(intervalId);
  if (boundaryId) clearTimeout(boundaryId);
  removeListeners?.();
  intervalId = boundaryId = removeListeners = undefined;
  running = false;
}

declareIndexPlugin(onActivate, onDeactivate);
