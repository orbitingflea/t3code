import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type AnyRouter, type RouterHistory, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { useThreadFindStore } from "~/components/chat/threadFindStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { useRightPanelStore } from "~/rightPanelStore";
import { resolveThreadRouteRef } from "~/threadRoutes";

import {
  decideMove,
  layoutOf,
  planWrite,
  readTabTag,
  type TabChange,
  userTabChange,
} from "./tabHistory.logic";
import { focusedTab, type TabId } from "./workArea.logic";

type TabHistoryRouter = Pick<AnyRouter, "parseLocation" | "getMatchedRoutes"> & {
  readonly history: RouterHistory;
};

const THREAD_ROUTE_ID = "/_chat/$environmentId/$threadId";

function locationShowsThread(router: TabHistoryRouter, thread: string): boolean {
  const { pathname } = router.parseLocation(router.history.location);
  const { foundRoute, routeParams } = router.getMatchedRoutes(pathname);
  const ref = foundRoute?.id === THREAD_ROUTE_ID ? resolveThreadRouteRef(routeParams) : null;
  return ref !== null && scopedThreadKey(ref) === thread;
}

type Landing = {
  readonly key: string;
  readonly back: boolean;
  readonly origin: string;
  skipped: boolean;
  handled: boolean;
};

// Last Back or Forward landing in a narrow window. Stores the landed entry key,
// direction, origin pathname, whether a skip stepped past it, and whether a watcher settled it.
let landing: Landing | null = null;
const recorded = new WeakSet<RouterHistory>();
// Unit tests run without a window, as a narrow one.
const wideWindow = () =>
  typeof window !== "undefined" &&
  !window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches;

// Adds one permanent listener per history before any watcher so Back or Forward from a page
// without a work area, such as Issues or Pull requests, is recorded. GO clears the landing,
// wide windows store nothing, and a skip keeps the origin of the move it continues. Only the
// landed thread's watcher settles the landing, at the event or when the watcher starts.
function recordLandings(history: RouterHistory) {
  if (recorded.has(history)) return;
  recorded.add(history);
  let previous = history.location;
  history.subscribe(({ location, action }) => {
    const before = previous;
    previous = location;
    if (action.type === "PUSH" || action.type === "REPLACE") return;
    const key = location.state.__TSR_key;
    if (action.type === "GO" || key === undefined || wideWindow()) landing = null;
    else if (before.state.__TSR_index !== location.state.__TSR_index) {
      // A skip keeps the origin of the move it continues.
      const origin =
        landing?.skipped && landing.key === before.state.__TSR_key
          ? landing.origin
          : before.pathname;
      landing = { key, back: action.type === "BACK", origin, skipped: false, handled: false };
    }
  });
}

/**
 * Records the user's tab switches and closes in `thread` into router history and answers
 * Back or Forward, including a landing that arrived before this watcher started.
 * Returns a stop function.
 */
export function watchTabHistory(
  router: TabHistoryRouter,
  thread: string,
  activate: (tab: TabId) => void,
): () => void {
  const { history } = router;
  recordLandings(history);
  const panels = () => useRightPanelStore.getState();
  let restoring = false;
  let pendingWrite: ReturnType<typeof setTimeout> | undefined;
  let pendingSkip: ReturnType<typeof setTimeout> | undefined;
  const cancelWrite = () => {
    clearTimeout(pendingWrite);
    pendingWrite = undefined;
  };

  const write = (change: TabChange) => {
    pendingWrite = undefined;
    const { byThreadKey, userActionRevisionByThreadKey } = panels();
    // A removed thread's queued switch, Settings, a draft, or another thread.
    if (userActionRevisionByThreadKey[thread] === undefined) return;
    if (!locationShowsThread(router, thread)) return;
    const { href, state } = history.location;
    const current = { href, tag: readTabTag(state) };
    const plan = planWrite(current, thread, change, focusedTab(layoutOf(byThreadKey, thread)));
    if (plan?.retag) {
      history.replace(href, { ...state, workAreaTab: plan.retag });
      // Browser history folds a replace and a push queued in one tick into one pushState.
      history.flush();
    }
    if (plan?.push) {
      history.push(plan.push.href, { workAreaTab: plan.push.tag });
      history.flush();
    }
  };

  const stopStore = useRightPanelStore.subscribe((next, prev) => {
    if (restoring || pendingWrite !== undefined) return;
    const findOpen = useThreadFindStore.getState().threadKey === thread;
    const change = userTabChange(prev, next, thread, findOpen);
    if (change === null) return;
    // A close retags at once because the same press may navigate away (Open in main view). A
    // switch waits a task, not a microtask, because one open runs several store writes, and
    // Reopen Closed View compares the location right after its awaited write.
    if (change.type === "close") write(change);
    else pendingWrite = setTimeout(write, 0, change);
  });

  const settle = () => {
    const { pathname, state } = history.location;
    const move = landing;
    const tag = readTabTag(state);
    if (move === null || move.key !== state.__TSR_key || move.handled) return;
    if (tag?.thread !== thread) return;
    move.handled = true;
    const sameOrigin = move.origin === pathname;
    const decision = decideMove({ tag, sameOrigin }, thread, panels().byThreadKey);
    if (decision.type === "show") {
      restoring = true; // the activate below bumps the user revision synchronously
      try {
        activate(decision.tab);
      } finally {
        restoring = false;
      }
    } else if (decision.type === "skip") {
      move.skipped = true;
      // Memory history notifies inside back(), so stepping here would re-enter this listener.
      pendingSkip = setTimeout(() => (move.back ? history.back() : history.forward()), 0);
    }
  };

  const stopHistory = history.subscribe(({ action }) => {
    clearTimeout(pendingSkip);
    if (action.type === "PUSH" || action.type === "REPLACE") return;
    // Any traversal leaves the entry the queued write would retag or push over.
    cancelWrite();
    settle();
  });
  settle();

  return () => {
    clearTimeout(pendingSkip);
    cancelWrite();
    stopStore();
    stopHistory();
  };
}

/** Runs `watchTabHistory` while `narrow` is true and does nothing in wide windows. */
export function useTabHistory(
  threadRef: ScopedThreadRef,
  narrow: boolean,
  activate: (tab: TabId) => void,
): void {
  const router = useRouter();
  const thread = scopedThreadKey(threadRef);
  const show = useStableCallback(activate);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- browser Back and Forward arrive as history events outside React
  useEffect(() => {
    if (!narrow) return () => {};
    return watchTabHistory(router, thread, show);
  }, [router, thread, narrow, show]);
}
