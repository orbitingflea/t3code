import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { create } from "zustand";

import { attachThreadFindTimeline } from "~/components/chat/threadFindStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { useInSubThreadView } from "../subThreads/subThreadsState";
import { useRightPanelPane } from "./tabStrip";
import { onViewEnd, type ViewId, viewAt } from "./viewIdentity";
import { leaves, resolveLayout } from "./workArea.logic";

type FindOwner = { readonly view: ViewId; readonly thread: string };

// The Chat views drawn in work-area panes, with the thread each shows. A reply's view is not a
// Chat of its thread, so it is never here.
const chatViews = new Map<ViewId, { readonly thread: string }>();

// The view that shows Find in split panes: each Find request names it, and it changes again only
// when that view ends.
const useFindOwner = create<{ readonly owner: FindOwner | null }>(() => ({ owner: null }));
onViewEnd((id) => {
  const { owner } = useFindOwner.getState();
  if (owner?.view === id) useFindOwner.setState({ owner: ownerFor(owner.thread) });
});

// Counts Find requests here, since the store counts from 1 again after a close.
let requests = 0;
// The request whose Find field took the keyboard.
let focusedAt = -1;

// The Chat view of `thread` that holds the keyboard, else the one in the focused pane, else the
// first one shown.
function ownerFor(thread: string): FindOwner | null {
  const views = [...chatViews].flatMap(([id, entry]) => {
    const at = entry.thread === thread ? viewAt(id) : undefined;
    return at === undefined ? [] : [{ id, ...at }];
  });
  const owner = views[0]?.owner;
  const record = owner === undefined ? undefined : useRightPanelStore.getState().byThreadKey[owner];
  if (record === undefined) return null;
  const layout = resolveLayout(record);
  const keyboard = document.activeElement
    ?.closest("[data-work-area-pane]")
    ?.getAttribute("data-work-area-pane");
  const order: string[] = leaves(layout.root).map((pane) => pane.id);
  const rank = (pane: string) => order.indexOf(pane);
  const pick =
    views.find((entry) => entry.view.pane === keyboard) ??
    views.find((entry) => entry.view.pane === layout.focused) ??
    views.toSorted((left, right) => rank(left.view.pane) - rank(right.view.pane))[0];
  return pick === undefined ? null : { view: pick.id, thread };
}

/**
 * Records a Find request and lets `findTakesFocus` grant focus once for it. Assigns Find to the
 * Chat view of `thread` holding keyboard focus, else the focused pane, else the first pane, or
 * clears ownership when `thread` is `null`.
 */
export function noteFindRequest(thread: string | null): void {
  requests += 1;
  useFindOwner.setState({ owner: thread === null ? null : ownerFor(thread) });
}

type FindTimeline = Parameters<typeof attachThreadFindTimeline>[0];

// Each Chat view's timeline. Find reads the timeline of the view a request names at that moment,
// so a request from another view starts from that view's place.
const timelines = new Map<ViewId, FindTimeline>();
const sharedTimelines = new Map<string, FindTimeline>();

function sharedTimeline(thread: string): FindTimeline {
  const timelineOf = () => {
    const named = ownerFor(thread)?.view;
    const own = named === undefined ? undefined : timelines.get(named);
    return own ?? [...timelines.values()].find((timeline) => timeline.threadKey === thread);
  };
  const shared = sharedTimelines.get(thread) ?? {
    threadKey: thread,
    readPosition: (query) => timelineOf()?.readPosition(query),
    navigate: () => timelineOf()?.navigate(),
  };
  sharedTimelines.set(thread, shared);
  return shared;
}

export function useAttachFindTimeline(): (timeline: FindTimeline) => () => void {
  const pane = useRightPanelPane();
  const reply = useInSubThreadView();
  const view = pane === null || pane.strip ? null : pane.view;
  return (timeline: FindTimeline) => {
    if (view === null) return attachThreadFindTimeline(timeline);
    if (reply) return () => {};
    timelines.set(view, timeline);
    const detach = attachThreadFindTimeline(sharedTimeline(timeline.threadKey));
    return () => {
      if (timelines.get(view) === timeline) timelines.delete(view);
      const thread = timeline.threadKey;
      if ([...timelines.values()].some((entry) => entry.threadKey === thread)) return;
      sharedTimelines.delete(thread);
      detach();
    };
  };
}

/**
 * Returns whether Find is open for `thread` in this view, and registers work-area Chat views for
 * Find ownership. Returns true when `thread` matches `openThread`, except in split panes where
 * only the owning Chat view (and any reply view) returns true.
 */
export function useFindInView(thread: ScopedThreadRef | null, openThread: string | null): boolean {
  const key = thread === null ? null : scopedThreadKey(thread);
  const pane = useRightPanelPane();
  // A reply draws its own matches while Find is open, but Find belongs to a Chat of the thread.
  const reply = useInSubThreadView();
  const view = reply ? null : (pane?.view ?? null);
  const owner = useFindOwner((state) => state.owner);
  const open = key !== null && openThread === key;
  const unowned = open && owner?.thread !== key;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists this Chat view for the Find requests that name the view showing Find
  useLayoutEffect(() => {
    if (view === null || key === null) return;
    const entry = { thread: key };
    chatViews.set(view, entry);
    // Find is open with no view, as when its view ended while this one was hidden.
    if (unowned) useFindOwner.setState({ owner: ownerFor(key) });
    return () => {
      if (chatViews.get(view) === entry) chatViews.delete(view);
    };
  }, [view, key, unowned]);
  if (!open || pane === null || view === null || pane.strip) return open;
  return owner?.view === view;
}

/**
 * Whether Find should focus `field`. Always true for `null` or outside a work-area pane; inside
 * one, returns true once per Find request so pane moves or closes do not steal focus.
 */
export function findTakesFocus(field: HTMLElement | null): boolean {
  // Outside the work area there is one view. In it, a request moves the keyboard to Find once,
  // and Find showing in another view after a move or a close leaves the keyboard where it is.
  if (field === null || field.closest("[data-work-area-pane]") === null) return true;
  if (focusedAt === requests) return false;
  focusedAt = requests;
  return true;
}
