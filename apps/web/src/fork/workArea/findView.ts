import { useLayoutEffect } from "react";
import { create } from "zustand";

import { useRightPanelPane } from "./tabStrip";
import { onViewEnd, type ViewId } from "./viewIdentity";

// The view that shows Find: the view that leads its chat at a Find request takes it and keeps it
// through moves and focus changes. Null from each request until a view takes it, and again once
// that view ends, when the view that leads then takes it.
const useFindView = create<{ readonly view: ViewId | null }>(() => ({ view: null }));
onViewEnd((id) => {
  if (useFindView.getState().view === id) useFindView.setState({ view: null });
});

// Counts Find requests here, since the store counts from 1 again after a close.
let requests = 0;
// The request whose Find field took the keyboard.
let focusedAt = -1;

export function noteFindRequest(): void {
  requests += 1;
  useFindView.setState({ view: null });
}

/**
 * Whether this view leads Find. Outside a work-area pane, always true; inside, follows the pane's
 * `leads` (true in the narrow strip, or in the focused pane showing the chat, else the first).
 */
export function useLeadsFind(): boolean {
  // The view that leads its chat holds the timeline a request reads its start from, as that view
  // takes Find.
  return useRightPanelPane()?.leads ?? true;
}

export function useFindInView(open: boolean): boolean {
  const pane = useRightPanelPane();
  const taker = useFindView((state) => state.view);
  const view = pane?.view;
  const leads = pane?.leads ?? true;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the view that leads at a Find request keeps Find until it ends
  useLayoutEffect(() => {
    if (open && taker === null && leads && view !== undefined) useFindView.setState({ view });
  }, [open, taker, leads, view]);
  // The one strip draws one view of a tab, which shows Find.
  if (!open || pane === null || pane.strip) return open;
  return taker === null ? leads : taker === view;
}

export function findTakesFocus(field: HTMLElement | null): boolean {
  // Outside the work area there is one view. In it, a request moves the keyboard to Find once,
  // and Find showing in another view after a move or a close leaves the keyboard where it is.
  if (field === null || field.closest("[data-work-area-pane]") === null) return true;
  if (focusedAt === requests) return false;
  focusedAt = requests;
  return true;
}
