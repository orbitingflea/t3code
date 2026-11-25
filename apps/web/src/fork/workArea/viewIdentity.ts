import { type ThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import {
  findPane,
  holders,
  leaves,
  parseViewKey,
  preferredView,
  resolveLayout,
  surfaceTabId,
  type TabId,
  type ViewKey,
  type ViewRef,
  viewKey,
  type WorkAreaLayout,
} from "./workArea.logic";

/** In-memory identity of one work-area view; follows a view across pane moves until it ends. */
export type ViewId = string & { readonly __viewId: unique symbol };

// In memory only: a reload starts fresh ids over the stored layout. Keyed by owner thread first,
// so a thread switch never shares ids, then by the view's current pane and tab.
const ids = new Map<string, Map<ViewKey, ViewId>>();
const endListeners = new Set<(id: ViewId) => void>();
// What a view of a file tab keeps showing after another view took a later line reveal.
const held = new Map<ViewId, unknown>();
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
export function knownViewId(owner: string, view: ViewRef): ViewId | undefined {
  return ids.get(owner)?.get(viewKey(view));
}

export function onViewEnd(listener: (id: ViewId) => void): () => void {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
}

/** Returns the owner thread key and current `ViewRef` for a tracked `id`, or `undefined`. */
export function viewAt(id: ViewId): { readonly owner: string; readonly view: ViewRef } | undefined {
  for (const [owner, byView] of ids) {
    for (const [key, value] of byView) {
      const view = value === id ? parseViewKey(key) : null;
      if (view !== null) return { owner, view };
    }
  }
  return undefined;
}

/**
 * Returns the file surface or payload held for `id` when another view takes a line reveal, or
 * `live` when none is held. A reveal targeting `id`, or `id` ending, clears the held value.
 */
export const shownBy = <T>(id: ViewId, live: T): T => (held.get(id) as T | undefined) ?? live;

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
  for (const id of ended) {
    held.delete(id);
    for (const listener of endListeners) listener(id);
  }
  for (const [owner, byView] of ids) {
    const before = previous[owner];
    const after = next[owner];
    if (before !== undefined && after !== undefined && after !== before)
      holdReveals(byView, before, after);
  }
}

// File tabs this write gave a new line reveal, each with the surface or payload it had before.
function revealsIn(
  before: ThreadRightPanelState,
  after: ThreadRightPanelState,
  was: WorkAreaLayout,
  layout: WorkAreaLayout,
): [TabId, unknown][] {
  const files = after.surfaces.flatMap((surface): [TabId, unknown][] => {
    const prior = before.surfaces.find((entry) => entry.id === surface.id);
    return surface.kind === "file" &&
      prior?.kind === "file" &&
      prior.revealRequestId !== surface.revealRequestId
      ? [[surfaceTabId(surface.id), prior]]
      : [];
  });
  const linked = Object.entries(layout.tabs).flatMap(([key, payload]): [TabId, unknown][] => {
    const tab = key as TabId;
    const prior = was.tabs[tab];
    return payload.kind === "linked-file" &&
      prior?.kind === "linked-file" &&
      prior.reveal !== payload.reveal
      ? [[tab, prior]]
      : [];
  });
  return [...files, ...linked];
}

// A reveal belongs to the view its write targets: the focused pane when it shows the tab, else the
// pane the write shows the tab in, else the reveal pick. Every other view the user has seen,
// hidden ones too, keeps what it showed.
function holdReveals(
  byView: ReadonlyMap<ViewKey, ViewId>,
  before: ThreadRightPanelState,
  after: ThreadRightPanelState,
) {
  const was = resolveLayout(before);
  const layout = resolveLayout(after);
  for (const [tab, prior] of revealsIn(before, after, was, layout)) {
    const holding = holders(layout.root, tab);
    const target =
      holding.find((pane) => pane.active === tab && pane.id === layout.focused) ??
      holding.find((pane) => pane.active === tab && findPane(was.root, pane.id)?.active !== tab) ??
      preferredView(layout, tab, layout.focused, "reveal");
    for (const pane of holding) {
      // A view never shown has no id; it opens on the live surface.
      const id = byView.get(viewKey({ pane: pane.id, tab }));
      if (id === undefined) continue;
      if (pane.id === target?.id) held.delete(id);
      else if (!held.has(id)) held.set(id, prior);
    }
  }
}
