import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ContextType, use, useEffect } from "react";

import type { AssistantCitationRequest } from "../../components/chat/AssistantCitationSource";
import { ThreadFindTimelineContext } from "../../components/chat/ThreadFindProvider";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { TimelineEntry } from "../../session-logic";
import { rowShownIn, subThreadOfReply } from "../displayMode/displayModeTimeline";
import { useThreadDisplayMode } from "../displayMode/useThreadDisplayMode";
import { chatFileTarget } from "../workArea/chatFileOpener";
import { ChatOpenerContext } from "../workArea/chatOpenerContext";
import { SubThreadViewContext } from "./subThreadsState";

type Find = NonNullable<ContextType<typeof ThreadFindTimelineContext>>;

// One object per Find state, so a view that does not show the match redraws no more often.
const withoutMatch = new WeakMap<Find, Find>();
function findWithoutMatch(find: Find): Find {
  let cleared = withoutMatch.get(find);
  if (cleared === undefined) withoutMatch.set(find, (cleared = { ...find, activeFindMatch: null }));
  return cleared;
}

const MAIN_FIND_HIGHLIGHTS = { all: "t3-thread-find", active: "t3-thread-find-active" };
const SUB_THREAD_FIND_HIGHLIGHTS = {
  all: "t3-sub-thread-find",
  active: "t3-sub-thread-find-active",
};

/**
 * The names of the CSS highlights that a chat view paints its Find matches under. Several views
 * share a name, each through its own `sharedHighlight`.
 */
export const useFindHighlightNames = () =>
  use(SubThreadViewContext) === null ? MAIN_FIND_HIGHLIGHTS : SUB_THREAD_FIND_HIGHLIGHTS;

/**
 * One view's ranges in the page's highlight `name`: it adds and removes only its own, so views that
 * share the name keep each other's.
 */
export function sharedHighlight(name: string) {
  const own = new Set<Range>();
  const remove = (range: Range) => {
    own.delete(range);
    const highlight = CSS.highlights.get(name);
    highlight?.delete(range);
    if (highlight?.size === 0) CSS.highlights.delete(name);
  };
  return {
    add: (range: Range) => {
      own.add(range);
      let highlight = CSS.highlights.get(name);
      if (highlight === undefined) CSS.highlights.set(name, (highlight = new Highlight()));
      highlight.add(range);
    },
    delete: remove,
    clear: () => {
      for (const range of own) remove(range);
    },
  };
}

function useOpenSubThread(
  reveal: "find" | "quote",
  threadRef: ScopedThreadRef | null,
  first: string | null,
  request: string | number | null,
) {
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  const opener = use(ChatOpenerContext);
  // Find steps keep focus and cover the chat only in one strip. Quote links show and focus the tab.
  const open = useStableCallback((thread: ScopedThreadRef, reply: string) =>
    (opener?.(thread) ?? chatFileTarget(null, thread)).openSubThread(reply, { reveal }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a quote link (the URL) or a Find step (its store) names a reply from outside this list; its reply tab then shows
  useEffect(() => {
    if (environmentId !== undefined && threadId !== undefined && first !== null && request !== null)
      open({ environmentId, threadId }, first);
  }, [environmentId, threadId, first, request, open]);
}

function useShowChatOnFind(
  threadRef: ScopedThreadRef | null,
  here: boolean,
  request: string | number | null,
) {
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  const opener = use(ChatOpenerContext);
  const show = useStableCallback((thread: ScopedThreadRef) => opener?.(thread).showOrigin());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a Find step (its store) lands on a row of this list; its Chat then shows where one strip drew a reply
  useEffect(() => {
    if (environmentId !== undefined && threadId !== undefined && here && request !== null)
      show({ environmentId, threadId });
  }, [environmentId, threadId, here, request, show]);
}

/**
 * The main list and an open sub-thread are two views of one history. Each gets the quote link and
 * the Find match only when it shows that row, so the other does not wait or load history for it.
 * For a reply, a Find step reveals the reply tab and leaves focus alone. A quote link shows the
 * reply tab and moves focus to it.
 */
export function useSubThreadReveal(
  threadRef: ScopedThreadRef | null,
  entries: ReadonlyArray<TimelineEntry>,
  cited: AssistantCitationRequest | null | undefined,
): { readonly citationRequest: AssistantCitationRequest | null; readonly find: Find | null } {
  const mode = useThreadDisplayMode(threadRef);
  const find = use(ThreadFindTimelineContext);
  const subThread = use(SubThreadViewContext);
  const citedId = cited?.citation.messageId;
  const findId = find?.activeFindMatch?.entryId;
  const shows = (id: string | undefined) => {
    if (!mode.subThreads || id === undefined) return true;
    const place = rowShownIn(entries, id, subThread);
    return subThread === null ? place !== "elsewhere" : place === "here";
  };
  const firstOf = (id: string | undefined) =>
    mode.subThreads && subThread === null && id !== undefined
      ? subThreadOfReply(entries, id)
      : null;
  useOpenSubThread("quote", threadRef, firstOf(citedId), cited?.key ?? null);
  useOpenSubThread("find", threadRef, firstOf(findId), find?.findNavigationId ?? null);
  useShowChatOnFind(
    threadRef,
    mode.subThreads &&
      subThread === null &&
      findId !== undefined &&
      rowShownIn(entries, findId, null) === "here",
    find?.findNavigationId ?? null,
  );
  return {
    citationRequest: cited != null && shows(citedId) ? cited : null,
    find: find === null || shows(findId) ? find : findWithoutMatch(find),
  };
}
