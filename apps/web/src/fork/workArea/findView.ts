import { useRightPanelPane } from "./tabStrip";

export function useLeadsFind(): boolean {
  // A chat open in several panes shows Find in the view that leads it now: the focused view,
  // else the first; the one strip leads. Outside the work area there is one view.
  return useRightPanelPane()?.leads ?? true;
}
