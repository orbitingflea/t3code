import type { ThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { leaves, resolveLayout, viewKey, type ViewRef } from "./workArea.logic";

/** Builds the reading-position scope key for a work-area `view` in `threadKey`. */
export const viewScope = (threadKey: string, view: ViewRef): string =>
  `${threadKey} ${viewKey(view)}`;

const viewsIn = (record: ThreadRightPanelState | undefined): ViewRef[] =>
  record === undefined
    ? []
    : leaves(resolveLayout(record).root).flatMap((pane) =>
        pane.tabs.map((tab) => ({ pane: pane.id, tab })),
      );

export function followViewScopes(
  scopes: {
    readonly forgetScope: (scope: string) => void;
    readonly moveScope: (from: string, to: string) => void;
  },
  panel: Pick<typeof useRightPanelStore, "subscribe">,
): () => void {
  // A view's own place lasts while its pane holds its tab, so a tab that comes back to a pane
  // starts again from the file's place. A view that moves to another pane takes its place along.
  return panel.subscribe((next, previous) => {
    if (next.byThreadKey === previous.byThreadKey) return;
    for (const [threadKey, before] of Object.entries(previous.byThreadKey)) {
      const after = next.byThreadKey[threadKey];
      if (after === before || (after?.workArea !== undefined && after.workArea === before.workArea))
        continue;
      const was = viewsIn(before);
      const now = viewsIn(after);
      const had = new Set(was.map(viewKey));
      const has = new Set(now.map(viewKey));
      const ended = was.filter((view) => !has.has(viewKey(view)));
      const started = now.filter((view) => !had.has(viewKey(view)));
      for (const view of ended) {
        const ofTab = (other: ViewRef) => other.tab === view.tab;
        // One write that ends one view of a tab and starts one is a move.
        const [to, ...more] = started.filter(ofTab);
        if (to !== undefined && more.length === 0 && ended.filter(ofTab).length === 1) {
          scopes.moveScope(viewScope(threadKey, view), viewScope(threadKey, to));
        } else {
          scopes.forgetScope(viewScope(threadKey, view));
        }
      }
    }
  });
}
