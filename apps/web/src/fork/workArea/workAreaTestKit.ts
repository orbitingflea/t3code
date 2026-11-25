import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import {
  holders,
  type LayoutNode,
  leaves,
  PRIMARY_CHAT,
  resolveLayout,
  surfaceTabId,
  type TabId,
  type ViewRef,
} from "./workArea.logic";
import { NO_VIEW } from "./workAreaGeometry.logic";
import type { WorkAreaChange } from "./workAreaPlacement.logic";
import { runOpen } from "./workAreaCommands";
import { publishWorkAreaView } from "./workAreaView";

/** The work-area logic tests' threads, sizes and store readers; the owner's layout is `ref`'s. */
export const env = EnvironmentId.make("env-1");
export const ref = scopeThreadRef(env, ThreadId.make("thread-primary"));
export const other = scopeThreadRef(env, ThreadId.make("thread-other"));
export const third = scopeThreadRef(env, ThreadId.make("thread-third"));
export const WIDE = { narrow: false, size: { width: 1200, height: 800 } };
export const wide = (width: number) => ({ narrow: false, size: { width, height: 800 } });

export function resetWorkAreaStore() {
  publishWorkAreaView(NO_VIEW);
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
}

export const store = () => useRightPanelStore.getState();
export const record = () => selectThreadRightPanelState(store().byThreadKey, ref);
export const layout = () => resolveLayout(record());
export const panes = () => leaves(layout().root);
export const paneAt = (index: number) => panes()[index]!;
export const holderOf = (tab: TabId) => holders(layout().root, tab)[0];
export const viewOf = (tab: TabId): ViewRef => ({ pane: holderOf(tab)!.id, tab });

export type Shape =
  | readonly string[]
  | { readonly axis: string; readonly first: Shape; readonly second: Shape };
export function shapeOf(node: LayoutNode): Shape {
  return node.kind === "pane"
    ? node.tabs
    : { axis: node.axis, first: shapeOf(node.first), second: shapeOf(node.second) };
}
export const shape = () => shapeOf(layout().root);
export const actives = () => panes().map((pane) => pane.active);
export const focusedIndex = () => panes().findIndex((pane) => pane.id === layout().focused);
export const change = (next: WorkAreaChange) => store().updateWorkArea(ref, next);
export const tab = surfaceTabId;
export const fromChat = <T>(act: () => T): T => runOpen({ record: ref, tab: PRIMARY_CHAT }, act);
export const chatAndFile: Shape = { axis: "row", first: ["chat"], second: ["file:a.ts"] };

/** One pane: [chat, ...files], the last file active. */
export function onePane(...files: string[]) {
  const narrow = publishWorkAreaView({ narrow: true, size: null });
  for (const file of files) store().openFile(ref, file);
  narrow();
}

/** Two panes: [chat] | [...files], the right pane focused. */
export function chatBeside(...files: string[]) {
  for (const file of files) store().openFile(ref, file);
}
