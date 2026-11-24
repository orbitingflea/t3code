import { createRouter, RouterHistory } from "@tanstack/react-router";

import { isWhiteboardBuild, WHITEBOARD_ROUTER_BASEPATH } from "./fork/whiteboard/build";
import { installTabHistoryHub } from "./fork/workArea/tabHistory";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  const router = createRouter({
    routeTree,
    history,
    ...(isWhiteboardBuild ? { basepath: WHITEBOARD_ROUTER_BASEPATH } : {}),
    context: {},
    defaultPreload: "intent",
  });
  installTabHistoryHub(router);
  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
