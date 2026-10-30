// Selected at build time with VITE_T3_WHITEBOARD=1 (apps/web/vite/whiteboardBuild.ts sets the
// matching `/chat/` base). The whiteboard page embeds that build as its chat panel.
export const isWhiteboardBuild = import.meta.env.VITE_T3_WHITEBOARD === "1";

export const WHITEBOARD_ROUTER_BASEPATH = "/chat";

/** True when this frame is the chat panel of the whiteboard page. */
export const isEmbeddedInWhiteboard = () => isWhiteboardBuild && window.parent !== window;
