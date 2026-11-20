import type { ScopedThreadRef } from "@t3tools/contracts";

import { focusTerminal } from "~/lib/terminalFocus";
import {
  type RightPanelKind,
  type RightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import { focusedTab, paneHolding, PRIMARY_CHAT, resolveLayout } from "./workArea.logic";

const readRecord = (threadRef: ScopedThreadRef) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

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

/**
 * `terminal.toggle` with the primary chat column hidden: show a terminal tab, or open one when
 * `openTerminalTab` is given (operate access). False when there is neither.
 */
export function showTerminalTab(
  threadRef: ScopedThreadRef,
  openTerminalTab: (() => void) | null,
): boolean {
  const terminal = readRecord(threadRef).surfaces.find((surface) => surface.kind === "terminal");
  if (terminal?.kind === "terminal") {
    useRightPanelStore.getState().activateSurface(threadRef, terminal.id);
    focusTerminal(threadRef, terminal.activeTerminalId);
    return true;
  }
  openTerminalTab?.();
  return openTerminalTab !== null;
}

/** Shows the primary chat column: activates its Chat tab, or puts it back in the focused pane. */
export function showPrimaryChat(threadRef: ScopedThreadRef): void {
  const layout = resolveLayout(readRecord(threadRef));
  useRightPanelStore.getState().updateWorkArea(
    threadRef,
    paneHolding(layout.root, PRIMARY_CHAT)
      ? { type: "activate", tab: PRIMARY_CHAT }
      : {
          type: "place",
          source: { threads: [threadRef] },
          at: { kind: "join", pane: layout.focused },
        },
  );
}

/** Opens the next `kind` the user opens as the active tab of the focused pane, as its + menu does. */
export function armFocusedPane(threadRef: ScopedThreadRef, kind: RightPanelKind): void {
  useRightPanelStore.getState().updateWorkArea(threadRef, {
    type: "arm",
    pane: resolveLayout(readRecord(threadRef)).focused,
    kind,
  });
}
