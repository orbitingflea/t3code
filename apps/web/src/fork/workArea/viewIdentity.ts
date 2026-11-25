import { type ThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import {
  leaves,
  parseViewKey,
  resolveLayout,
  type ViewKey,
  type ViewRef,
  viewKey,
} from "./workArea.logic";

/** In-memory identity of one work-area view; follows a view across pane moves until it ends. */
export type ViewId = string & { readonly __viewId: unique symbol };

// In memory only: a reload starts fresh ids over the stored layout. Keyed by owner thread first,
// so a thread switch never shares ids, then by the view's current pane and tab.
const ids = new Map<string, Map<ViewKey, ViewId>>();
const endListeners = new Set<(id: ViewId) => void>();
let minted = 0;
let following = false;

/**
 * Returns the stable `ViewId` for `view` in `owner`, minting one on first lookup. Starts
 * tracking right-panel writes so the id follows a tab moved between panes and ends on close.
 */
export function viewIdOf(owner: string, view: ViewRef): ViewId {
  if (!following) {
    following = true;
    useRightPanelStore.subscribe((next, previous) => {
      if (next.byThreadKey !== previous.byThreadKey)
        followWrite(next.byThreadKey, previous.byThreadKey);
    });
  }
  const byView = ids.get(owner) ?? new Map<ViewKey, ViewId>();
  ids.set(owner, byView);
  const key = viewKey(view);
  const id = byView.get(key) ?? (`view-${(minted += 1)}` as ViewId);
  byView.set(key, id);
  return id;
}

/** Calls `listener` when a tracked work-area view ends; returns the unsubscribe function. */
export function onViewEnd(listener: (id: ViewId) => void): () => void {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

const viewsIn = (record: ThreadRightPanelState | undefined): ViewKey[] =>
  record === undefined
    ? []
    : leaves(resolveLayout(record).root).flatMap((pane) =>
        pane.tabs.map((tab) => viewKey({ pane: pane.id, tab })),
      );

function followWrite(
  next: Readonly<Record<string, ThreadRightPanelState>>,
  previous: Readonly<Record<string, ThreadRightPanelState>>,
) {
  const ended: ViewId[] = [];
  for (const [owner, byView] of ids) {
    const before = previous[owner];
    const after = next[owner];
    if (after === before || (after?.workArea !== undefined && after.workArea === before?.workArea))
      continue;
    const was = new Set(viewsIn(before));
    const now = new Set(viewsIn(after));
    const tabOf = (key: ViewKey) => parseViewKey(key)?.tab;
    const endedKeys = [...was].filter((key) => !now.has(key));
    const startedKeys = [...now].filter((key) => !was.has(key));
    // A moved id lands on a key in `now`, which the loop then passes over.
    for (const [key, id] of byView) {
      if (now.has(key)) continue;
      byView.delete(key);
      // One write that ends one view of a tab and starts one is a move: the view keeps its id.
      const ofTab = (other: ViewKey) => tabOf(other) === tabOf(key);
      const [to, ...more] = startedKeys.filter(ofTab);
      if (to !== undefined && more.length === 0 && endedKeys.filter(ofTab).length === 1) {
        const replaced = byView.get(to);
        if (replaced !== undefined) ended.push(replaced);
        byView.set(to, id);
      } else {
        ended.push(id);
      }
    }
    if (byView.size === 0) ids.delete(owner);
  }
  for (const id of ended) for (const listener of endListeners) listener(id);
}
