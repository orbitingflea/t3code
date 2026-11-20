import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";
import { readEnvironmentSupportsServerBrowser } from "~/state/entities";

/**
 * Shows browsers an agent or another client revealed for a thread, forced or by the auto-show
 * setting, as one automatic open in the thread's work area. It never floats or moves focus.
 */
export function revealServerTabs(
  threadRef: ScopedThreadRef,
  sessions: ReadonlyArray<PreviewSessionSnapshot>,
  options: { readonly autoShowFloatingPreview: boolean },
): void {
  if (!readEnvironmentSupportsServerBrowser(threadRef.environmentId)) return;
  for (const session of sessions) {
    if (!options.autoShowFloatingPreview && session.revealRequest?.force !== true) continue;
    useRightPanelStore.getState().openBrowser(threadRef, session.tabId, true);
  }
}
