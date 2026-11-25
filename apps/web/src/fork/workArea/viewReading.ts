import type { ThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { leaves, resolveLayout, viewKey, type ViewRef } from "./workArea.logic";

export const viewScope = (threadKey: string, view: ViewRef): string =>
  `${threadKey} ${viewKey(view)}`;

function viewScopes(threadKey: string, record: ThreadRightPanelState | undefined): Set<string> {
  if (record === undefined) return new Set();
  return new Set(
    leaves(resolveLayout(record).root).flatMap((pane) =>
      pane.tabs.map((tab) => viewScope(threadKey, { pane: pane.id, tab })),
    ),
  );
}

export function forgetEndedViews(
  forget: (scope: string) => void,
  panel: Pick<typeof useRightPanelStore, "subscribe">,
): void {
  // A view's own place lasts while its pane holds its tab, so a tab that comes back to a pane
  // starts again from the file's place.
  panel.subscribe((next, previous) => {
    if (next.byThreadKey === previous.byThreadKey) return;
    for (const [threadKey, before] of Object.entries(previous.byThreadKey)) {
      const after = next.byThreadKey[threadKey];
      if (after === before || (after?.workArea !== undefined && after.workArea === before.workArea))
        continue;
      const live = viewScopes(threadKey, after);
      for (const scope of viewScopes(threadKey, before)) if (!live.has(scope)) forget(scope);
    }
  });
}
