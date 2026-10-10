/**
 * Drives RemNote's native tab bar through its own UI.
 *
 * The plugin SDK (as of @remnote/plugin-sdk 0.0.46) has no API for tabs or tab locking, so this
 * module works the way a person would: it finds a tab, right-clicks it, reads whether the menu
 * offers "Lock Tab" or "Unlock Tab", and clicks that item only when a change is wanted.
 *
 * Safety rules enforced here:
 *  - An element only counts as a tab once its own context menu offers a lock/unlock item.
 *  - The only menu items ever clicked are ones whose text is exactly a configured lock/unlock label.
 *  - Every lock/unlock is re-checked by reading the menu again afterwards.
 *  - Elements inside the editor (contenteditable), dialogs or popups are never treated as tabs.
 */

export type LockState = 'locked' | 'unlocked';

export interface DriverOptions {
  /** Optional CSS selector that matches one element per tab; overrides the built-in heuristics. */
  tabSelector?: string;
  /** Menu labels that lock a tab (case-insensitive, exact text). */
  lockLabels: string[];
  /** Menu labels that unlock a tab (case-insensitive, exact text). */
  unlockLabels: string[];
  /** How long to wait for a context menu to appear. */
  menuTimeoutMs?: number;
  /** Tabs live in a band at the top of the window; ignore matches lower than this (CSS px). */
  tabBandMaxBottomPx?: number;
  log?: (...args: unknown[]) => void;
}

export interface TabRef {
  el: HTMLElement;
  title: string;
}

export interface ProbedTab extends TabRef {
  state: LockState;
}

const EXCLUDED_ANCESTORS = [
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="tooltip"]',
  '.rn-dialog',
  '.rn-popup2',
  '.rn-menu',
  '.rn-doc-menu',
  '.rn-doc-title',
  '.rn-doc-header7',
  '.rn-document',
  '.rn-editor22',
  '.rn-omnibar7',
  '.rn-plugin-root',
].join(',');

export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() >= end) return undefined;
    await sleep(intervalMs);
  }
}

export class TabDriver {
  private readonly lock: Set<string>;
  private readonly unlock: Set<string>;

  constructor(private readonly doc: Document, private readonly opts: DriverOptions) {
    this.lock = new Set(opts.lockLabels.map((l) => norm(l).toLowerCase()).filter(Boolean));
    this.unlock = new Set(opts.unlockLabels.map((l) => norm(l).toLowerCase()).filter(Boolean));
  }

  private get win(): Window {
    return this.doc.defaultView ?? window;
  }

  private log(...a: unknown[]) {
    this.opts.log?.(...a);
  }

  // ---------------------------------------------------------------- geometry / visibility

  isVisible(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = this.win.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  }

  private inTabBand(el: Element): boolean {
    const r = el.getBoundingClientRect();
    const maxBottom = this.opts.tabBandMaxBottomPx ?? 240;
    return r.top >= -1 && r.bottom <= maxBottom && r.height <= 80 && r.width <= 600;
  }

  private excluded(el: Element): boolean {
    return !!el.closest(EXCLUDED_ANCESTORS);
  }

  // ---------------------------------------------------------------- finding tabs

  /** Keep only the innermost element of each nested group (one element per tab). */
  private innermost(els: HTMLElement[]): HTMLElement[] {
    const set = new Set(els);
    return els.filter((el) => {
      for (const other of set) if (other !== el && el.contains(other)) return false;
      return true;
    });
  }

  /**
   * A tab's title is its longest text node, so icon glyphs or a "×" close button rendered as
   * separate text inside the tab don't change it.
   */
  titleOf(el: Element): string {
    let best = '';
    const walker = this.doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = norm(n.nodeValue);
      if (t.length > best.length) best = t;
    }
    return best;
  }

  private toRefs(els: HTMLElement[], applyBandFilter: boolean): TabRef[] {
    const filtered = els.filter(
      (el) =>
        this.isVisible(el) &&
        !this.excluded(el) &&
        (!applyBandFilter || this.inTabBand(el)) &&
        norm(el.textContent).length > 0 &&
        norm(el.textContent).length <= 300,
    );
    return this.innermost(filtered)
      .map((el) => ({ el, title: this.titleOf(el) }))
      .filter((r) => r.title.length > 0);
  }

  /** Elements that look like tabs, from a user selector or built-in heuristics. Unverified. */
  listTabCandidates(): TabRef[] {
    const sel = this.opts.tabSelector?.trim();
    if (sel) {
      try {
        return this.toRefs([...this.doc.querySelectorAll<HTMLElement>(sel)], false);
      } catch (e) {
        this.log('Invalid tab selector', sel, e);
        return [];
      }
    }
    const byRole = this.toRefs([...this.doc.querySelectorAll<HTMLElement>('[role="tab"]')], true);
    if (byRole.length) return byRole;
    const byName = [
      ...this.doc.querySelectorAll<HTMLElement>(
        '[data-tab-id],[data-tabid],[data-testid*="tab" i],[class*="tab" i]',
      ),
    ].filter((el) => !/\b(table|tabular|stable|tabindex)/i.test(String(el.className)));
    return this.toRefs(byName, true);
  }

  /**
   * Elements titled `title`: tab-like candidates first, then any other visible text match in the
   * tab band (a same-titled look-alike must not hide the real tab). Unverified; callers must
   * probe before acting.
   */
  findByTitle(title: string): HTMLElement[] {
    const t = norm(title);
    const fromCandidates = this.listTabCandidates()
      .filter((c) => c.title === t)
      .map((c) => c.el);
    if (this.opts.tabSelector?.trim()) return fromCandidates;

    const matches: HTMLElement[] = [];
    const walker = this.doc.createTreeWalker(this.doc.body, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n as HTMLElement;
      if (norm(el.textContent) !== t) continue;
      if (!this.isVisible(el) || !this.inTabBand(el) || this.excluded(el)) continue;
      matches.push(el);
    }
    const covered = (el: HTMLElement) => fromCandidates.some((c) => c === el || c.contains(el) || el.contains(c));
    return [...fromCandidates, ...this.innermost(matches).filter((el) => !covered(el))];
  }

  // ---------------------------------------------------------------- menus

  /** Visible elements whose own text node is exactly a lock or unlock label. */
  private visibleMenuLabels(): { el: HTMLElement; state: LockState }[] {
    const out: { el: HTMLElement; state: LockState }[] = [];
    const walker = this.doc.createTreeWalker(this.doc.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = norm(n.nodeValue).toLowerCase();
      if (!text || text.length > 40) continue;
      const isUnlock = this.unlock.has(text);
      const isLock = !isUnlock && this.lock.has(text);
      if (!isUnlock && !isLock) continue;
      const el = n.parentElement;
      if (!el || !this.isVisible(el) || el.closest('[contenteditable="true"]')) continue;
      // An "Unlock" item means the tab is currently locked.
      out.push({ el, state: isUnlock ? 'locked' : 'unlocked' });
    }
    return out;
  }

  private menuItemTarget(label: HTMLElement): HTMLElement {
    return (
      label.closest<HTMLElement>('[role="menuitem"],[role="option"],button,li,a') ?? label
    );
  }

  private center(el: Element) {
    const r = el.getBoundingClientRect();
    return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  }

  private fireMouse(el: Element, type: string, button: number) {
    const init = { bubbles: true, cancelable: true, composed: true, view: this.win, button,
      buttons: button === 2 ? 2 : 1, ...this.center(el) };
    const PE = (this.win as unknown as { PointerEvent?: typeof PointerEvent }).PointerEvent;
    const ev = type.startsWith('pointer') && PE
      ? new PE(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(type, init);
    el.dispatchEvent(ev);
  }

  /** Close any open menu without choosing anything. */
  async closeMenus(): Promise<boolean> {
    if (!this.visibleMenuLabels().length) return true;
    for (let i = 0; i < 3; i++) {
      // Avoid sending Escape into the editor unless the menu ignores it everywhere else.
      const targets: EventTarget[] = [this.doc.body, this.doc];
      if (i > 0 && this.doc.activeElement) targets.unshift(this.doc.activeElement);
      for (const t of targets) {
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27,
          bubbles: true, cancelable: true }));
      }
      if (await waitFor(() => this.visibleMenuLabels().length === 0, 300)) return true;
    }
    const backdrop = this.doc.querySelector<HTMLElement>('.rn-popup-background');
    if (backdrop) {
      this.fireMouse(backdrop, 'mousedown', 0);
      backdrop.click();
    }
    return !!(await waitFor(() => this.visibleMenuLabels().length === 0, 400));
  }

  /**
   * Right-click `el` and read its lock state from the menu that opens, then close the menu.
   * Returns undefined when no lock/unlock item appears (so `el` is not a tab).
   */
  async probe(el: HTMLElement): Promise<LockState | undefined> {
    const r = await this.openMenu(el);
    if (!r) return undefined;
    await this.closeMenus();
    return r.state;
  }

  private async openMenu(el: HTMLElement): Promise<{ state: LockState; label: HTMLElement } | undefined> {
    if (!(await this.closeMenus())) {
      this.log('A menu with lock/unlock items is already open and would not close; skipping.');
      return undefined;
    }
    if (!el.isConnected) return undefined;
    this.fireMouse(el, 'pointerdown', 2);
    this.fireMouse(el, 'mousedown', 2);
    this.fireMouse(el, 'pointerup', 2);
    this.fireMouse(el, 'mouseup', 2);
    this.fireMouse(el, 'contextmenu', 2);
    const found = await waitFor(() => {
      const labels = this.visibleMenuLabels();
      if (!labels.length) return undefined;
      const states = new Set(labels.map((l) => l.state));
      if (states.size !== 1) return { ambiguous: true as const };
      return { state: labels[0].state, label: labels[0].el };
    }, this.opts.menuTimeoutMs ?? 900);
    if (!found) {
      // Something else may have opened (e.g. a rem menu on a non-tab element); close it.
      for (const t of [this.doc.body, this.doc]) {
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      }
      return undefined;
    }
    if ('ambiguous' in found) {
      this.log('Menu offered both Lock and Unlock; refusing to act.');
      await this.closeMenus();
      return undefined;
    }
    return found;
  }

  /**
   * Make `el`'s tab locked or unlocked. `relocate` must return a fresh element for the same tab,
   * because RemNote may re-render the tab bar after any change.
   */
  async setLocked(
    relocate: () => HTMLElement[],
    want: LockState,
  ): Promise<boolean> {
    // Try each element with the tab's title; only a real tab opens a menu with lock items.
    const openFirst = async () => {
      for (const el of relocate()) {
        const m = await this.openMenu(el);
        if (m) return m;
      }
      return undefined;
    };
    const stateNow = async () => {
      const m = await openFirst();
      if (m) await this.closeMenus();
      return m?.state;
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const menu = await openFirst();
      if (!menu) return false;
      if (menu.state === want) {
        await this.closeMenus();
        return true;
      }
      const target = this.menuItemTarget(menu.label);
      if (attempt === 0) {
        target.click();
      } else {
        // Some menus act on pointer events rather than click.
        this.fireMouse(target, 'pointerdown', 0);
        this.fireMouse(target, 'mousedown', 0);
        this.fireMouse(target, 'pointerup', 0);
        this.fireMouse(target, 'mouseup', 0);
        target.click();
      }
      await waitFor(() => !target.isConnected || !this.isVisible(target), 600);
      await this.closeMenus();
      await sleep(150);
      if ((await stateNow()) === want) return true;
    }
    return false;
  }

  /** Switch to a tab. `isActive` confirms it worked (e.g. the expected rem is now open). */
  async activate(el: HTMLElement, isActive: () => Promise<boolean>): Promise<boolean> {
    await this.closeMenus();
    el.click();
    if (await waitFor(isActive, 800, 80)) return true;
    // Tab strips often switch on mousedown instead of click.
    this.fireMouse(el, 'pointerdown', 0);
    this.fireMouse(el, 'mousedown', 0);
    this.fireMouse(el, 'pointerup', 0);
    this.fireMouse(el, 'mouseup', 0);
    return !!(await waitFor(isActive, 1200, 80));
  }

  /** A "new tab" button, only if it identifies itself by aria-label or title. */
  findNewTabButton(): HTMLElement | undefined {
    return [...this.doc.querySelectorAll<HTMLElement>('[aria-label],[title],[data-tooltip]')].find(
      (el) =>
        /^(new|open new|add) tab$/i.test(
          norm(el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('data-tooltip')),
        ) && this.isVisible(el) && !this.excluded(el),
    );
  }

  /** Snapshot for the diagnose command. */
  describeCandidates() {
    return this.listTabCandidates().map(({ el, title }) => {
      const r = el.getBoundingClientRect();
      return {
        title,
        tag: el.tagName.toLowerCase(),
        className: String(el.className).slice(0, 160),
        role: el.getAttribute('role'),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        parentClass: String(el.parentElement?.className ?? '').slice(0, 160),
      };
    });
  }
}
