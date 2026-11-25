import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  browserMiniPlayerSource,
  previewMiniPlayerSourceKey,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { setActivePreviewTab } from "~/previewStateStore";
import {
  type RightPanelKind,
  type RightPanelSurface,
  rightPanelHostRef,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import { miniPlayerDraws } from "./miniPlayerFollow";
import {
  type ArmKind,
  focusedTab,
  type PaneId,
  paneHolding,
  resolveLayout,
  surfaceTabId,
} from "./workArea.logic";
import { currentDropAt, runWithOpenOrigin, shownSurfaceOf } from "./workAreaView";

const readRecord = (threadRef: ScopedThreadRef) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

/**
 * Runs `run` as an open from `origin`, recording the record's current surface tabs as `existing`.
 * This is the one way fork code starts an open origin.
 */
export const runOpen = <T>(origin: Parameters<typeof runWithOpenOrigin>[0], run: () => T): T =>
  runWithOpenOrigin(
    {
      ...origin,
      existing: new Set(
        readRecord(origin.record).surfaces.map((surface) => surfaceTabId(surface.id)),
      ),
    },
    run,
  );

/**
 * Arms `pane` for `kind`, runs `open` from that pane, and returns its result, clearing the arm if
 * an async `open` settles without its tab. Under a live drop, runs `open` directly with no arm or
 * menu origin so the drop's place or the user's newer action decides.
 */
export function openFromPaneMenu<T>(
  threadRef: ScopedThreadRef,
  pane: PaneId,
  kind: ArmKind,
  open: () => T,
): T {
  // A drop lands at its own place, or where the user's newer action put the focus.
  if (currentDropAt(threadRef) !== null) return open();
  const armed = { pane, kind };
  useRightPanelStore.getState().updateWorkArea(threadRef, { type: "arm", armed });
  const result = runOpen({ record: threadRef, armed }, open);
  // An async open that settles without its tab must not leave its pick to the next open. A sync
  // open keeps it: Device setup's dialog opens the Device tab later, in this pane.
  if (result instanceof Promise) {
    const disarm = () =>
      useRightPanelStore.getState().updateWorkArea(threadRef, { type: "disarm", armed });
    void result.then(disarm, disarm);
  }
  return result;
}

/**
 * `rightPanel.close`: the focused pane's active tab. A surface takes its own close path; a linked
 * file or a Chat closes in the work area, which refuses the last Chat. False when nothing closed.
 */
export function closeFocusedTab(
  threadRef: ScopedThreadRef,
  closeSurface: (surface: RightPanelSurface) => void,
): boolean {
  const record = readRecord(threadRef);
  const layout = resolveLayout(record);
  const tab = focusedTab(layout);
  const payload = layout.tabs[tab];
  if (payload === undefined || payload.kind === "surface") {
    const surface = record.surfaces.find((entry) => entry.id === tab);
    if (!surface) return false;
    closeSurface(surface);
    return true;
  }
  useRightPanelStore.getState().updateWorkArea(threadRef, { type: "close", tab });
  return paneHolding(resolveLayout(readRecord(threadRef)).root, tab) === undefined;
}

/** Opens the next `kind` the user opens as the active tab of the focused pane, as its + menu does. */
export function armFocusedPane(threadRef: ScopedThreadRef, kind: RightPanelKind): void {
  useRightPanelStore.getState().updateWorkArea(threadRef, {
    type: "arm",
    armed: { pane: resolveLayout(readRecord(threadRef)).focused, kind },
  });
}

export function togglePreview(threadRef: ScopedThreadRef): boolean {
  const host = rightPanelHostRef(threadRef);
  const record = readRecord(host);
  const player = usePreviewMiniPlayerStore.getState();
  const floated = player.byThreadKey[scopedThreadKey(threadRef)];
  if (
    floated?.source.kind === "browser" &&
    resolveLayout(record).floating?.tab === surfaceTabId(previewMiniPlayerSourceKey(floated.source))
  ) {
    player.close(threadRef);
    useRightPanelStore.getState().openBrowser(threadRef, floated.source.tabId);
    return true;
  }
  const browser = shownSurfaceOf(record, "preview");
  if (browser?.kind !== "preview") return false;
  if (browser.resourceId === null) {
    useRightPanelStore.getState().closeSurface(host, browser.id);
    return true;
  }
  const source = browserMiniPlayerSource(browser.resourceId);
  // With no mini player to draw it, the tab stays in its pane.
  if (!miniPlayerDraws(threadRef, source)) return true;
  player.open(threadRef, source);
  setActivePreviewTab(threadRef, browser.resourceId);
  useRightPanelStore.getState().close(threadRef);
  return true;
}

export function toggleDiff(threadRef: ScopedThreadRef): void {
  const host = rightPanelHostRef(threadRef);
  const diff = shownSurfaceOf(readRecord(host), "diff");
  if (diff === undefined) useRightPanelStore.getState().open(threadRef, "diff");
  else useRightPanelStore.getState().closeSurface(host, diff.id);
}
