/**
 * Sandboxed mode: keep the locked tab on today's daily note by swapping the note it shows.
 *
 * A sandboxed plugin can't press Lock/Unlock in the tab bar, but it can change which rem the
 * current tab's panes show (plugin.window.setRemWindowTree). A tab's lock belongs to the tab,
 * so replacing yesterday's daily note with today's inside the locked tab keeps the lock on
 * today's note.
 *
 * Which tab gets swapped: the plugin remembers the daily note that was "today" when it last ran.
 * After the day changes, the first time the current tab shows that note, it's replaced with
 * today's note — once. Tabs showing anything else (lectures, other documents) are never changed.
 */

export type PaneLeaf = { remId: string; paneId: string };
export type Tree<L> = L | { direction: 'row' | 'column'; first: Tree<L>; second: Tree<L>; splitPercentage?: number };

export interface InPlaceState {
  /** Daily note id that was "today" when the plugin last ran. */
  todayId: string;
  /** Previous day's note still waiting to be swapped in its tab. */
  pendingFromId?: string;
}

export interface InPlaceHost {
  getToday(): Promise<{ id: string; title: string }>;
  getTree(): Promise<Tree<PaneLeaf> | undefined>;
  setTree(tree: Tree<string>): Promise<void>;
  /** True if the rem is a daily document (used only by the manual command). */
  isDailyDoc(remId: string): Promise<boolean>;
  load(): Promise<InPlaceState | undefined>;
  save(state: InPlaceState): Promise<void>;
  log(...a: unknown[]): void;
}

export interface InPlaceResult {
  swapped: boolean;
  /** False if RemNote put today's note in a different tab instead of the current one. */
  sameTab?: boolean;
  today: string;
  reason: string;
}

const isLeaf = <L>(t: Tree<L>): t is L =>
  !(typeof t === 'object' && t !== null && 'first' in (t as object) && 'second' in (t as object));

export function leaves<L>(t: Tree<L>): L[] {
  return isLeaf(t) ? [t] : [...leaves(t.first), ...leaves(t.second)];
}

export function mapTree<A, B>(t: Tree<A>, f: (leaf: A) => B): Tree<B> {
  if (isLeaf(t)) return f(t);
  const out: Tree<B> = { direction: t.direction, first: mapTree(t.first, f), second: mapTree(t.second, f) };
  if (t.splitPercentage !== undefined) out.splitPercentage = t.splitPercentage;
  return out;
}

/**
 * Run one check. `force` (the manual command) also swaps any past daily note in the current tab,
 * not only the remembered one.
 */
export async function checkInPlace(host: InPlaceHost, force = false): Promise<InPlaceResult> {
  const today = await host.getToday();
  let state = await host.load();

  if (!state) {
    // First run: remember today's note; tomorrow it becomes the one to swap.
    state = { todayId: today.id };
    await host.save(state);
  } else if (state.todayId !== today.id) {
    // New day. If an older swap never happened, that older note is still what the tab shows.
    state = { todayId: today.id, pendingFromId: state.pendingFromId ?? state.todayId };
    await host.save(state);
    host.log('Day changed; waiting to swap', state.pendingFromId, '→', today.id);
  }

  if (!state.pendingFromId && !force) return { swapped: false, today: today.title, reason: 'nothing pending' };

  const tree = await host.getTree();
  if (!tree) return { swapped: false, today: today.title, reason: 'no open document' };

  const replace = new Set<string>();
  for (const leaf of leaves(tree)) {
    if (leaf.remId === today.id) continue;
    if (leaf.remId === state.pendingFromId) replace.add(leaf.remId);
    else if (force && (await host.isDailyDoc(leaf.remId))) replace.add(leaf.remId);
  }
  if (!replace.size) {
    return {
      swapped: false,
      today: today.title,
      reason: force ? "this tab isn't showing a past daily note" : 'locked daily tab not visited yet',
    };
  }

  const panesBefore = new Set(leaves(tree).map((l) => l.paneId));
  await host.setTree(mapTree(tree, (l) => (replace.has(l.remId) ? today.id : l.remId)));

  const after = await host.getTree();
  const afterLeaves = after ? leaves(after) : [];
  const showsToday = afterLeaves.some((l) => l.remId === today.id);
  const sameTab = afterLeaves.some((l) => panesBefore.has(l.paneId));
  if (!showsToday) return { swapped: false, today: today.title, reason: 'RemNote did not switch the note' };

  await host.save({ todayId: today.id });
  return { swapped: true, sameTab, today: today.title, reason: 'swapped' };
}
