import { createRouter, RouterHistory } from "@tanstack/react-router";

import { isWhiteboardBuild, WHITEBOARD_ROUTER_BASEPATH } from "./fork/whiteboard/build";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    ...(isWhiteboardBuild ? { basepath: WHITEBOARD_ROUTER_BASEPATH } : {}),
    context: {},
    defaultPreload: "intent",
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
