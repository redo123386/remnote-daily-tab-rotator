import { detectTitleFormat, pastTitles } from './dates';
import { LockState, TabDriver, sleep, waitFor } from './tabDriver';

/** What the rotation needs from RemNote. Implemented with the plugin SDK in index.tsx. */
export interface RotationHost {
  /** The daily document that counts as today (created if missing). */
  getToday(): Promise<{ id: string; title: string; date: Date }>;
  /**
   * The rem id if `title` names an existing daily document, else undefined.
   * Must never create anything.
   */
  resolveDailyDoc(title: string): Promise<string | undefined>;
  /** Open today's daily document in the focused pane. */
  openToday(): Promise<void>;
  /** Rem ids shown in the panes of the current tab. */
  openPaneRemIds(): Promise<string[]>;
  log(...args: unknown[]): void;
}

export interface RotationOptions {
  switchToToday: boolean;
  /** How many past days to look for by title when tab heuristics find nothing. */
  lookbackDays: number;
}

export interface RotationReport {
  ok: boolean;
  today: string;
  openedToday: boolean;
  lockedToday: boolean;
  alreadyLocked: boolean;
  unlocked: string[];
  errors: string[];
}

interface DailyTab {
  title: string;
  remId: string;
  state: LockState;
}

/**
 * Find the verified tab element for `title`: the first element with that text whose own context
 * menu offers Lock/Unlock. Returns the element and its current state.
 */
async function locateVerified(driver: TabDriver, title: string) {
  for (const el of driver.findByTitle(title)) {
    const state = await driver.probe(el);
    if (state) return { el, state };
  }
  return undefined;
}

/** A relocate() for setLocked: the verified element first (if still mounted), then fresh matches. */
function relocator(driver: TabDriver, title: string, verified?: HTMLElement) {
  return () => {
    const els = driver.findByTitle(title);
    return verified?.isConnected ? [verified, ...els.filter((e) => e !== verified)] : els;
  };
}

/** Switch to the tab titled `title`, clicking only an element verified to be a tab. */
async function activateTab(driver: TabDriver, title: string, isActive: () => Promise<boolean>) {
  const found = await locateVerified(driver, title);
  return !!found && (await driver.activate(found.el, isActive));
}

export async function rotate(
  driver: TabDriver,
  host: RotationHost,
  opts: RotationOptions,
): Promise<RotationReport> {
  const today = await host.getToday();
  const report: RotationReport = {
    ok: false,
    today: today.title,
    openedToday: false,
    lockedToday: false,
    alreadyLocked: false,
    unlocked: [],
    errors: [],
  };

  // 1. Collect titles of open tabs that might be daily notes from previous days.
  const titles = new Set(driver.listTabCandidates().map((c) => c.title));
  const format = detectTitleFormat(today.date, today.title);
  if (format) {
    for (const t of pastTitles(today.date, format, opts.lookbackDays)) {
      if (driver.findByTitle(t).length) titles.add(t);
    }
  }
  titles.delete(today.title);

  // 2. Keep only real daily documents, then confirm each is a tab and read its lock state.
  const oldDaily: DailyTab[] = [];
  for (const title of titles) {
    const remId = await host.resolveDailyDoc(title);
    if (!remId) continue; // not a daily note (e.g. a lecture) — never touched
    const found = await locateVerified(driver, title);
    if (found) oldDaily.push({ title, remId, state: found.state });
  }
  host.log('Previous daily-note tabs:', oldDaily);

  // 3. Make sure today's note is open in a tab.
  let todayTab = await locateVerified(driver, today.title);
  if (!todayTab) {
    report.openedToday = true;
    // Opening a document from a locked tab makes RemNote put it in a new tab, which keeps the
    // tab the user is in intact. Prefer yesterday's locked daily tab as that launch point.
    const anchor = oldDaily.find((t) => t.state === 'locked');
    if (anchor) {
      const ok = await activateTab(driver, anchor.title,
        async () => (await host.openPaneRemIds()).includes(anchor.remId));
      if (!ok) host.log('Could not switch to the previous locked daily tab first; opening anyway.');
    } else {
      const plus = driver.findNewTabButton();
      if (plus) {
        plus.click();
        await sleep(300);
      }
    }
    await host.openToday();
    const appeared = await waitFor(() => driver.findByTitle(today.title).length > 0, 5000, 100);
    if (appeared) {
      await sleep(250);
      todayTab = await locateVerified(driver, today.title);
    }
    if (!todayTab) {
      report.errors.push(`Opened "${today.title}" but could not find its tab in the tab bar.`);
      return report; // leave every lock as it was
    }
  }

  // 4. Lock today's tab before unlocking anything, so a daily tab is always locked.
  if (todayTab.state === 'locked') {
    report.alreadyLocked = true;
    report.lockedToday = true;
  } else {
    report.lockedToday = await driver.setLocked(relocator(driver, today.title, todayTab.el), 'locked');
    if (!report.lockedToday) {
      report.errors.push(`Could not lock the "${today.title}" tab.`);
      return report; // don't unlock yesterday if today isn't locked
    }
  }

  // 5. Unlock previous days' daily-note tabs. Other locked tabs are never considered.
  for (const t of oldDaily) {
    if (t.state !== 'locked') continue;
    const ok = await driver.setLocked(relocator(driver, t.title), 'unlocked');
    if (ok) report.unlocked.push(t.title);
    else report.errors.push(`Could not unlock the "${t.title}" tab.`);
  }

  // 6. Bring today's tab to the front.
  if (opts.switchToToday) {
    const ok = await activateTab(driver, today.title,
      async () => (await host.openPaneRemIds()).includes(today.id));
    if (!ok) host.log("Could not confirm switching to today's tab.");
  }

  report.ok = report.lockedToday && report.errors.length === 0;
  return report;
}
