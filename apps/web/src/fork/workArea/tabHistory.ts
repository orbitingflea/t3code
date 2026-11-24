import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  type AnyRouter,
  type HistoryLocation,
  type RouterHistory,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import {
  assistantCitationFromLocation,
  withoutAssistantCitationHash,
} from "~/lib/assistantCitationNavigation";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { useRightPanelStore } from "~/rightPanelStore";
import { resolveThreadRouteRef } from "~/threadRoutes";

import {
  decideHistoryMove,
  decideMove,
  isTabStep,
  layoutOf,
  planPush,
  type TabChange,
  type TabEntry,
  userShownTabChange,
} from "./tabHistory.logic";
import { tabHistoryTags, type TabTags } from "./tabHistoryTags";
import { focusedTab, type TabId } from "./workArea.logic";

type TabHistoryRouter = Pick<AnyRouter, "parseLocation" | "getMatchedRoutes"> & {
  readonly history: RouterHistory;
};

const THREAD_ROUTE_ID = "/_chat/$environmentId/$threadId";

function threadRouteRef(
  router: TabHistoryRouter,
  location: HistoryLocation,
): ScopedThreadRef | null {
  const { pathname } = router.parseLocation(location);
  const { foundRoute, routeParams } = router.getMatchedRoutes(pathname);
  return foundRoute?.id === THREAD_ROUTE_ID ? resolveThreadRouteRef(routeParams) : null;
}

/** Marks all recorded tab-history entries for `ref` as deleted so Back and Forward skip them. */
export const markTabHistoryThreadDeleted = (ref: ScopedThreadRef): void =>
  tabHistoryTags.markDead(scopedThreadKey(ref));

// The tag of our push in flight, until its PUSH event takes it.
let pushing: TabEntry | undefined;
let ownPushInFlight = false;
// Our consecutive pushes on one history: the entry before them, each entry they pushed, and the last.
let ownRun: {
  readonly history: RouterHistory;
  readonly passed: Set<HistoryLocation>;
  latest: HistoryLocation;
} | null = null;
// The location of the latest history event, when it was one of our pushes or a same-thread step.
let lastTabStep: HistoryLocation | null = null;

/**
 * Returns `true` when an own tab push is in flight or only consecutive tab pushes by this code
 * changed history since `base`.
 */
export const onlyOwnTabPushesSince = (base: HistoryLocation): boolean =>
  ownPushInFlight ||
  (ownRun !== null && ownRun.history.location === ownRun.latest && ownRun.passed.has(base));

// Upstream test doubles of the router history send events without a location.
/**
 * Returns `true` when an own tab push is in flight or `location` came from this code's tab push
 * or a same-thread Back or Forward step.
 */
export const isWorkAreaTabStep = (location: HistoryLocation | undefined): boolean =>
  ownPushInFlight || (location !== undefined && location === lastTabStep);

type Step = "BACK" | "FORWARD";
type HistoryHub = {
  readonly push: (href: string, tag: TabEntry) => void;
  readonly skip: (step: Step) => void;
  readonly noteModalClose: (href: string) => void;
};

const hubs = new WeakMap<RouterHistory, HistoryHub>();

// One listener per history, installed with the router and never removed, so it runs before any
// listener that reads our tags or the helpers above. It classifies every event, tags our pushes
// in their own notify, and makes the moves no thread view can: skips over a deleted thread's and
// a wide window's tab entries, and the push that ends a Settings or Usage Close.
function hubFor(router: TabHistoryRouter, tags: TabTags, isWide: () => boolean): HistoryHub {
  const { history } = router;
  const known = hubs.get(history);
  if (known !== undefined) return known;
  let previous = history.location;
  let pendingSkip: (() => void) | undefined;
  // Our pending skip, and the tag the user's Back started from while that Back has a base ahead.
  let chain: { readonly step: Step; readonly origin: TabEntry | null } | null = null;
  // The page a Settings or Usage Close returns to, until the next history event.
  let modalReturn: string | null = null;
  const push = (href: string, tag: TabEntry) => {
    pushing = tag;
    ownPushInFlight = true;
    try {
      history.push(href);
      // Commit now so a replace later in this tick cannot fold into the push.
      history.flush();
    } finally {
      // A blocker can defer the push; its PUSH event then gets only the eager tag.
      pushing = undefined;
      ownPushInFlight = false;
    }
  };
  // The Close goes back to the entry before the page it returns to and navigates there again,
  // which the router skips when that entry has the same URL. A fresh entry here drops the modal
  // from Forward history in its place.
  const pushModalReturn = (location: HistoryLocation, href: string) => {
    const ref = threadRouteRef(router, location);
    const landed = withoutAssistantCitationHash(router.parseLocation(location).href);
    if (ref === null || landed !== href) return;
    const thread = scopedThreadKey(ref);
    const tab = focusedTab(layoutOf(useRightPanelStore.getState().byThreadKey, thread));
    // Marked as ours in both widths, so one wide Back still passes it and the run before it.
    push(withoutAssistantCitationHash(location.href), { thread, tab, pushed: true });
  };
  const skip = (step: Step, origin: TabEntry | null = null) => {
    const go = step === "BACK" ? () => history.back() : () => history.forward();
    chain = { step, origin };
    pendingSkip = go;
    // A microtask runs before the router renders a missing thread and redirects. Memory
    // history notifies inside back(), so stepping right here would re-enter the listeners.
    queueMicrotask(() => {
      if (pendingSkip !== go) return;
      pendingSkip = undefined;
      go();
    });
  };
  history.subscribe(({ location, action }) => {
    pendingSkip = undefined;
    const before = previous;
    previous = location;
    const ownSkip = chain?.step === action.type ? chain : null;
    chain = null;
    lastTabStep = null;
    const closing = modalReturn;
    modalReturn = null;
    if (action.type === "PUSH" && pushing !== undefined) {
      tags.set(location.state, pushing);
      pushing = undefined;
      const run =
        ownRun?.history === history
          ? ownRun
          : { history, passed: new Set([before]), latest: location };
      run.passed.add(location);
      run.latest = location;
      ownRun = run;
      lastTabStep = location;
      return;
    }
    if (ownRun?.history === history) ownRun = null;
    if (action.type === "GO" && closing !== null) pushModalReturn(location, closing);
    if (action.type !== "BACK" && action.type !== "FORWARD") return;
    const left = tags.get(before.state);
    const move = {
      entry: tags.get(location.state),
      samePath: before.pathname === location.pathname,
      moved: before.state.__TSR_index !== location.state.__TSR_index,
      // A user's own Back starts a new chain; Forward never passes a base.
      origin: action.type === "BACK" ? (ownSkip === null ? left : ownSkip.origin) : null,
    };
    if (isTabStep(move, left)) lastTabStep = location;
    const decision = decideHistoryMove(move, isWide());
    if (decision !== "none") skip(action.type, decision === "skip" ? move.origin : null);
  });
  const hub: HistoryHub = {
    push,
    skip,
    noteModalClose: (href) => {
      modalReturn = href;
    },
  };
  hubs.set(history, hub);
  return hub;
}

const INPUT_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

const windowIsWide = () => !window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches;

/**
 * Installs the one per-history listener on `router.history` (no-op if already installed).
 * It tags this code's pushes, skips dead entries in both widths, skips pushed entries and at most
 * one base per Back in wide mode, and pushes a fresh `pushed` entry on a marked modal Close.
 */
export const installTabHistoryHub = (router: TabHistoryRouter): void =>
  void hubFor(router, tabHistoryTags, windowIsWide);

/**
 * Marks the next history event on `history` as a Settings or Usage Close returning to `href`.
 * If that event is a `GO` landing on a matching thread route, the listener pushes a fresh
 * hashless `pushed` entry for the shown tab in both widths; any event clears the mark.
 */
export const noteAppModalClose = (history: RouterHistory, href: string): void =>
  hubs.get(history)?.noteModalClose(href);

/**
 * Ensures the per-history listener exists (using `deps.tags` and `deps.isWide` if not yet
 * installed) and returns a stop function. In narrow mode it tags entries of `thread`, pushes user
 * tab changes, and restores open tabs or skips closed or already-shown same-URL entries.
 */
export function watchTabHistory(deps: {
  readonly router: TabHistoryRouter;
  readonly thread: string;
  readonly narrow: boolean;
  readonly activate: (tab: TabId) => void;
  readonly tags: TabTags;
  readonly input: EventTarget | undefined;
  readonly isWide: () => boolean;
}): () => void {
  const { router, thread, narrow, activate, tags, input } = deps;
  const { history } = router;
  const hub = hubFor(router, tags, deps.isWide);
  // A wide window steps as if no tab entry existed, which the history's own listener handles.
  if (!narrow) return () => {};
  const layout = () => layoutOf(useRightPanelStore.getState().byThreadKey, thread);
  const shownTab = () => focusedTab(layout());
  const showsThread = () => {
    const ref = threadRouteRef(router, history.location);
    return ref !== null && scopedThreadKey(ref) === thread;
  };
  let previous = history.location;
  let restoring = false;
  // A change on a quote entry with no pointer, key or touch input since the entry was reached is
  // the quote's own reveal.
  let inputSinceArrival = false;
  let pending: { change: TabChange; reveal: boolean; timer: ReturnType<typeof setTimeout> } | null =
    null;

  const cancelPush = () => {
    if (pending !== null) clearTimeout(pending.timer);
    pending = null;
  };

  // Entries pushed by the router or by anyone else record the tab shown when they are reached.
  const tagShown = () => {
    if (!showsThread()) return;
    const { state } = history.location;
    if (tags.get(state)?.thread !== thread) tags.set(state, { thread, tab: shownTab() });
  };

  const write = () => {
    if (pending === null) return;
    const { change, reveal } = pending;
    pending = null;
    if (!showsThread()) return;
    const { href, state } = history.location;
    const current = {
      tag: tags.get(state),
      reveal: reveal && assistantCitationFromLocation(href) !== null,
    };
    const plan = planPush(current, thread, change);
    if (plan === null) return;
    if (plan.retag !== null) tags.set(state, plan.retag);
    // A copy of the quote hash would run the quote's reveal again on Back or Forward.
    if (plan.type === "push") hub.push(withoutAssistantCitationHash(href), plan.push);
  };

  const stopStore = useRightPanelStore.subscribe((next, prev) => {
    if (restoring) return;
    const change = userShownTabChange(prev, next, thread);
    if (change === null) return;
    // The entry records the tab the user chose, even if a reveal shows another before it is written.
    if (pending !== null) {
      pending.change = { from: pending.change.from, to: change.to };
      return;
    }
    // A task, not a microtask, so the store writes of one gesture make one entry.
    pending = { change, reveal: !inputSinceArrival, timer: setTimeout(write, 0) };
  });

  const noteInput = () => {
    inputSinceArrival = true;
  };
  for (const type of INPUT_EVENTS) {
    input?.addEventListener(type, noteInput, { capture: true, passive: true });
  }

  const stopHistory = history.subscribe(({ location, action }) => {
    const before = previous;
    previous = location;
    inputSinceArrival = false;
    if (action.type === "BACK" || action.type === "FORWARD") {
      cancelPush();
      const move = {
        entry: tags.get(location.state),
        samePath: before.pathname === location.pathname,
        sameHref: before.href === location.href,
        moved: before.state.__TSR_index !== location.state.__TSR_index,
      };
      const decision = decideMove(move, { thread, layout: layout() });
      if (decision.type === "show") {
        restoring = true;
        try {
          activate(decision.tab);
        } finally {
          restoring = false;
        }
      } else if (decision.type === "skip") {
        hub.skip(action.type);
      }
    }
    tagShown();
  });

  tagShown();

  return () => {
    cancelPush();
    for (const type of INPUT_EVENTS) input?.removeEventListener(type, noteInput, { capture: true });
    stopStore();
    stopHistory();
  };
}

/**
 * Runs narrow-mode tab-history tracking for `threadRef` and calls `activate` when Back or Forward
 * shows a tab. The router's per-history listener handles dead-entry skips in both widths, wide
 * skips of pushed entries and one base per Back, and marked modal-Close pushes.
 */
export function useTabHistory(
  threadRef: ScopedThreadRef,
  narrow: boolean,
  activate: (tab: TabId) => void,
): void {
  const router = useRouter();
  const thread = scopedThreadKey(threadRef);
  const show = useStableCallback(activate);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- browser Back and Forward arrive as history events outside React
  useEffect(
    () =>
      watchTabHistory({
        router,
        thread,
        narrow,
        activate: show,
        tags: tabHistoryTags,
        input: window,
        isWide: windowIsWide,
      }),
    [router, thread, narrow, show],
  );
}
