import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type {
  AnyRouter,
  HistoryLocation,
  HistoryState,
  RouterHistory,
} from "@tanstack/react-router";

import { useComposerDraftStore } from "~/composerDraftStore";
import { withoutAssistantCitationHash } from "~/lib/assistantCitationNavigation";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import {
  rightPanelHostRef,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { isThreadRoutePathname } from "~/threadRoutes";

import {
  carryTag,
  planLanding,
  planMove,
  readTabTag,
  type TabMove,
  type TabTag,
} from "./tabHistory.logic";
import { setTabMoveHandler } from "./tabMoveScope";
import { focusedTab, paneHolding, resolveLayout, type TabId } from "./workArea.logic";
import { activateShownPreview } from "./workAreaCommands";

type HistoryAction = Parameters<Parameters<RouterHistory["subscribe"]>[0]>[0]["action"];

const gone = new Map<string, ScopedThreadRef>();
// The locations tab writes made, and the key of each entry they made to the key of the entry its
// route visit started on. Keys also match the router's own parsed copies of a location.
const writes = new WeakSet<HistoryLocation>();
const visits = new Map<string, string>();
type Entry = { readonly state: { readonly __TSR_key?: string | undefined } };
const keyOf = (entry: Entry) => entry.state.__TSR_key ?? "";
const visitOf = (entry: Entry) => visits.get(keyOf(entry)) ?? keyOf(entry);

/**
 * Returns `true` when `a` and `b` belong to the same route visit, joined only by tab writes.
 * Accepts any `{ state }` location, including router `latestLocation`, and matches by entry key
 * in a narrow window. In a wide window, checks object identity.
 */
export const sameRouteVisit = (a: Entry, b: Entry): boolean =>
  a === b ||
  (narrowWindow().matches &&
    (visits.has(keyOf(a)) || visits.has(keyOf(b))) &&
    visitOf(a) === visitOf(b));

/** Returns `true` when `location` was written by narrow-window tab history. */
export const isTabHistoryWrite = (location: HistoryLocation): boolean => writes.has(location);

/** Marks `ref` as deleted in this window so Back and Forward step past its entries. */
export function forgetTabHistoryThread(ref: ScopedThreadRef): void {
  gone.set(scopedThreadKey(ref), ref);
}

let narrowQuery: MediaQueryList | null = null;
const narrowWindow = () =>
  (narrowQuery ??= window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY));

/**
 * Returns `true` when the window is narrow and `location` carries a `TabTag`.
 * Callers skip location-driven reveals, such as quote links, while tab history owns the entry.
 */
export const tabHistoryOwnsLocation = (location: { readonly state: HistoryState }): boolean =>
  narrowWindow().matches && readTabTag(location.state) !== null;

const layoutOf = (owner: ScopedThreadRef) =>
  resolveLayout(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, owner));

// Unique per write, so two entries never deep-equal and the router never merges a re-push.
const TAG_SESSION = Math.random().toString(36).slice(2, 10);
let tagCount = 0;
const newTag = (owner: ScopedThreadRef, tab: TabId): TabTag => ({
  environmentId: owner.environmentId,
  threadId: owner.threadId,
  tab,
  id: `${TAG_SESSION}-${(tagCount += 1)}`,
});

function directionOf(action: HistoryAction): -1 | 0 | 1 {
  if (action.type === "BACK") return -1;
  if (action.type === "FORWARD") return 1;
  if (action.type === "GO") return action.index < 0 ? -1 : action.index > 0 ? 1 : 0;
  return 0;
}

/**
 * Connects narrow-window work-area tab history to `router` and installs the user tab-move handler.
 * Call once at router creation, before the first route loads. Wraps `history.subscribe` to attach
 * ahead of the first outside subscriber, detach with the last, and re-attach ahead of the next.
 */
export function followTabHistory(router: AnyRouter): void {
  const history: RouterHistory = router.history;
  const narrow = narrowWindow();
  let previous = history.location;
  // The notifications of one notify loop, settled once in a microtask after it.
  let batch: { readonly from: HistoryLocation; last: HistoryAction } | null = null;
  // The app's own skip step, counted only while each pop lands where it expects. `from` is the
  // pathname the user's press started on, which every landing of the walk compares with.
  let walk: { readonly expect: number; readonly steps: number; readonly from: string } | null =
    null;
  let writing: string | null = null;

  const settle = () => {
    const done = batch;
    const stepped = walk;
    batch = null;
    walk = null;
    if (done === null || !narrow.matches) return;
    const landed = history.location;
    const index = landed.state.__TSR_index;
    const last = done.last.type === "PUSH" || done.last.type === "REPLACE" ? "write" : "pop";
    const moved = index !== done.from.state.__TSR_index;
    // Only a pop that moved can land on a stop to show or skip.
    if (last === "write" || !moved) return;
    const tag = readTabTag(landed.state);
    const layout = tag === null ? null : layoutOf(tag);
    const { pathname } = router.parseLocation(landed);
    const continued = stepped !== null && stepped.expect === index ? stepped : null;
    const steps = continued?.steps ?? 0;
    const from = continued?.from ?? done.from.pathname;
    const landing = planLanding({
      last,
      direction: directionOf(done.last),
      moved,
      tag,
      gonePath: [...gone.values()].some((ref) => isThreadRoutePathname(pathname, ref)),
      showable: tag !== null && layout !== null && paneHolding(layout.root, tag.tab) !== undefined,
      shown: layout === null ? null : focusedTab(layout),
      samePath: from === landed.pathname,
      atStart: index === 0,
      steps,
    });
    if (landing.kind === "show") {
      const owner = scopeThreadRef(landing.tag.environmentId, landing.tag.threadId);
      useRightPanelStore.getState().updateWorkArea(owner, { type: "show", tab: landing.tag.tab });
      activateShownPreview(owner);
    } else if (landing.kind === "step") {
      walk = { expect: index + landing.delta, steps: steps + 1, from };
      if (landing.delta < 0) history.back();
      else history.forward();
    }
  };

  const follow: Parameters<RouterHistory["subscribe"]>[0] = ({ location, action }) => {
    if (writing !== null) {
      writes.add(location);
      visits.set(keyOf(location), writing);
    }
    if (narrow.matches) {
      if (batch === null) {
        batch = { from: previous, last: action };
        queueMicrotask(settle);
      } else {
        batch.last = action;
      }
    }
    previous = location;
  };
  // The router loads a navigation itself only while the history has no subscriber, so this one
  // joins the first subscriber, ahead of it, and so runs first in each notification. It leaves
  // with the last one.
  const subscribe = history.subscribe;
  const outside = new Set<Parameters<RouterHistory["subscribe"]>[0]>();
  let stopFollowing: (() => void) | null = null;
  history.subscribe = (subscriber) => {
    if (stopFollowing === null) {
      previous = history.location;
      stopFollowing = subscribe(follow);
    }
    outside.add(subscriber);
    const unsubscribe = subscribe(subscriber);
    return () => {
      unsubscribe();
      outside.delete(subscriber);
      if (outside.size === 0 && stopFollowing !== null) {
        stopFollowing();
        stopFollowing = null;
      }
    };
  };

  const commit = router.commitLocation;
  router.commitLocation = (next) => {
    const state = carryTag(router.latestLocation, next, narrow.matches);
    return commit(state === null ? next : { ...next, state });
  };

  const onOwnersPage = (owner: ScopedThreadRef, entry: HistoryLocation) => {
    const { location } = router.state;
    if (location.state.__TSR_key !== entry.state.__TSR_key) return false;
    if (isThreadRoutePathname(location.pathname, owner)) return true;
    const draftId = useComposerDraftStore.getState().getDraftIdByRef(owner);
    return draftId !== null && location.pathname === `/draft/${draftId}`;
  };

  const write = (entry: HistoryLocation, owner: ScopedThreadRef, move: TabMove) => {
    const href = withoutAssistantCitationHash(entry.href);
    writing = visitOf(entry);
    try {
      if (move.retag !== null) {
        history.replace(entry.href, { ...entry.state, workAreaTab: newTag(owner, move.retag) });
        // The browser folds a replace and a push queued in one task into one push.
        history.flush();
      }
      // Dropping a citation hash renders a new href, which must not reset the window's scroll.
      if (href !== entry.href) router.resetNextScroll = false;
      history.push(href, { workAreaTab: newTag(owner, move.push) });
    } finally {
      writing = null;
    }
  };

  setTabMoveHandler((target) => {
    if (!narrow.matches) return null;
    const owner = rightPanelHostRef(target);
    const entry = history.location;
    if (!onOwnersPage(owner, entry)) return null;
    const left = focusedTab(layoutOf(owner));
    return () => {
      // A move that navigated made its own entry.
      if (history.location !== entry) return;
      const move = planMove(readTabTag(entry.state), owner, left, focusedTab(layoutOf(owner)));
      if (move !== null) write(entry, owner, move);
    };
  });
}
