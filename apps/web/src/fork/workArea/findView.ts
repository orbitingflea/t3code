import { useRightPanelPane } from "./tabStrip";

/**
 * Whether this view leads Find. Outside a work-area pane, always true; inside, follows the pane's
 * `leads` (true in the narrow strip, or in the focused pane showing the chat, else the first).
 */
export function useLeadsFind(): boolean {
  // A chat open in several panes shows Find in the view that leads it now: the focused view,
  // else the first; the one strip leads. Outside the work area there is one view.
  return useRightPanelPane()?.leads ?? true;
}
