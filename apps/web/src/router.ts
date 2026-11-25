import { createRouter, RouterHistory } from "@tanstack/react-router";

import { isWhiteboardBuild, WHITEBOARD_ROUTER_BASEPATH } from "./fork/whiteboard/build";
import { followTabHistory } from "./fork/workArea/tabHistory";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  const router = createRouter({
    routeTree,
    history,
    ...(isWhiteboardBuild ? { basepath: WHITEBOARD_ROUTER_BASEPATH } : {}),
    context: {},
    defaultPreload: "intent",
  });
  followTabHistory(router);
  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
