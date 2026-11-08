import { useEffect, useRef, useState } from "react";
import { PresentationIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { isEmbeddedInWhiteboard } from "./build";

// The whiteboard parent page reports whether its board panel is collapsed; asking on mount
// covers the report it sent before this listener existed. Null until the first report.
export function useWhiteboardBoardHidden() {
  const [boardHidden, setBoardHidden] = useState<boolean | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window message listener for the board page's layout reports, held while mounted
  useEffect(() => {
    if (!isEmbeddedInWhiteboard()) return;
    const receive = (event: MessageEvent) => {
      if (event.source === window.parent && event.data?.type === "wb-layout") {
        setBoardHidden(event.data.boardHidden === true);
      }
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "wb-layout-get" }, "*");
    return () => window.removeEventListener("message", receive);
  }, []);
  return boardHidden;
}

// The whiteboard build starts open only when standalone and wide enough; inside the board's iframe
// the start state comes from its layout report (useWhiteboardSidebarStartState). It keeps no stored
// open state: a stored `true` would open the sidebar over the board, and the iframe's setOpen(true)
// would carry over to the standalone page.
export function whiteboardSidebarProviderProps(sidebarFits: boolean) {
  return { defaultOpen: !isEmbeddedInWhiteboard() && sidebarFits };
}

// In the whiteboard the first layout report sets the start state: with the board hidden this
// frame is the whole page, so the sidebar opens by the same width rule as standalone.
export function useWhiteboardSidebarStartState(
  boardHidden: boolean | null,
  sidebarFits: boolean,
  setOpen: (open: boolean) => void,
) {
  const startStateSet = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies the board page's first layout report, which arrives by message after mount, to the sidebar provider once
  useEffect(() => {
    if (boardHidden === null || startStateSet.current) return;
    startStateSet.current = true;
    if (boardHidden && sidebarFits) void setOpen(true);
  }, [boardHidden, sidebarFits, setOpen]);
}

// Header content clears the Board button (w-18 plus mr-2) placed before the sidebar trigger.
export const WHITEBOARD_BOARD_BUTTON_TITLEBAR_STYLE = {
  "--workspace-titlebar-content-left":
    "calc(var(--workspace-controls-left) + var(--workspace-titlebar-control-size) + var(--workspace-titlebar-control-gap) + 5rem)",
};

// Below 760px RightPanelSheet switches to its phone width, which can start under the Board button.
// Sheets render in portals beside the app's #root.
const HIDDEN_UNDER_PHONE_RIGHT_PANEL_SHEET =
  "max-[760px]:in-[#root:has(~[data-base-ui-portal]>[data-slot=sheet-viewport]>[data-slot=sheet-popup]:is([data-open],[data-ending-style]))]:hidden";

export function WhiteboardBoardButton() {
  return (
    <div className={`pointer-events-auto mr-2 w-18 ${HIDDEN_UNDER_PHONE_RIGHT_PANEL_SHEET}`}>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => window.parent.postMessage({ type: "wb-show-board" }, "*")}
      >
        <PresentationIcon />
        Board
      </Button>
    </div>
  );
}
