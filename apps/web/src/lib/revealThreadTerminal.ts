import type { ScopedThreadRef } from "@t3tools/contracts";

import { panelHostedElsewhere } from "../fork/workArea/chatFileOpener";
import { userTabMove } from "../fork/workArea/tabMoveScope";
import { userTerminalActions } from "../fork/workArea/userTabActions";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { focusTerminalOnNavigation } from "./terminalFocus";

export function revealThreadTerminal(threadRef: ScopedThreadRef, terminalId: string) {
  const panels = useRightPanelStore.getState();
  const surface = selectThreadRightPanelState(panels.byThreadKey, threadRef).surfaces.find(
    (surface) => surface.kind === "terminal" && surface.terminalIds.includes(terminalId),
  );
  // A hosted thread's activations route to its host; the drawer follower writes its own record.
  if (surface && !panelHostedElsewhere(threadRef)) {
    userTabMove(threadRef, () => {
      panels.activateTerminal(threadRef, surface.id, terminalId);
      panels.activateSurface(threadRef, surface.id);
    });
    focusTerminalOnNavigation(threadRef, terminalId);
    return;
  }
  userTerminalActions().ensureTerminal(threadRef, terminalId, {
    open: true,
    active: true,
  });
  focusTerminalOnNavigation(threadRef, terminalId);
}
