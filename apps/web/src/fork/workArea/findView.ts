import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { ThreadRightPanelState } from "~/rightPanelStore";

import { useRightPanelPane } from "./tabStrip";
import { preferredView, resolveLayout } from "./workArea.logic";

// The layouts as the newest Find request found them.
let requested: {
  readonly request: number;
  readonly byThreadKey: Readonly<Record<string, ThreadRightPanelState>>;
} | null = null;

/**
 * Records the work-area layouts at the moment Find `request` starts, so `useFindInView` keeps
 * Find in the view that led the request.
 */
export function noteFindRequest(
  request: number,
  byThreadKey: Readonly<Record<string, ThreadRightPanelState>>,
): void {
  requested = { request, byThreadKey };
}

/**
 * Gates thread Find `open` to the work-area view that led `request`. Uses the snapshot from
 * `noteFindRequest` when it matches `request`, else falls back to `pane.leads`. Returns `open`
 * outside a work-area pane.
 */
export function useFindInView(open: boolean, request: number): boolean {
  const pane = useRightPanelPane();
  if (!open || pane === null) return open;
  // A chat open in several panes shows Find in the view that led the request, the focused one
  // else the first, even once another view mounts or takes the focus.
  const record =
    requested?.request === request ? requested.byThreadKey[scopedThreadKey(pane.owner)] : undefined;
  const layout = record === undefined ? null : resolveLayout(record);
  const led =
    layout === null ? undefined : preferredView(layout, pane.view.tab, layout.focused, "reveal");
  return led === undefined ? pane.leads : led.id === pane.view.pane;
}
