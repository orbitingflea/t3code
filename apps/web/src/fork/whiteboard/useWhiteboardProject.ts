import { useEffect } from "react";

import { isEmbeddedInWhiteboard } from "./build";

// The board binds its room to the project directory this chat is working in,
// so it has to hear which one that is whenever the active thread moves.
export function useWhiteboardProject(workspaceRoot: string | undefined, threadKey: string | null) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the board page (parent window, outside React) bound to this chat's project through postMessage
  useEffect(() => {
    if (!workspaceRoot || !isEmbeddedInWhiteboard()) return;
    window.parent.postMessage({ type: "wb-project", path: workspaceRoot, session: threadKey }, "*");
  }, [workspaceRoot, threadKey]);
}
