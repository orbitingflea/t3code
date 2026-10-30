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

export function WhiteboardBoardButton() {
  return (
    <div className="pointer-events-auto mr-2 w-18">
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
