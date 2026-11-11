import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ContextType, use, useEffect } from "react";

import type { AssistantCitationRequest } from "../../components/chat/AssistantCitationSource";
import { ThreadFindTimelineContext } from "../../components/chat/ThreadFindProvider";
import type { TimelineEntry } from "../../session-logic";
import { rowShownIn, subThreadOfReply } from "../displayMode/displayModeTimeline";
import { useThreadDisplayMode } from "../displayMode/useThreadDisplayMode";
import { openSubThread, SubThreadViewContext } from "./subThreadsState";

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
 * The names of the CSS highlights that a chat view paints its Find matches under. The page keeps
 * one highlight per name, so a sub-thread's view has its own and does not clear the main list's.
 */
export const useFindHighlightNames = () =>
  use(SubThreadViewContext) === null ? MAIN_FIND_HIGHLIGHTS : SUB_THREAD_FIND_HIGHLIGHTS;

function useOpenSubThread(
  threadRef: ScopedThreadRef | null,
  first: string | null,
  request: string | number | null,
) {
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a quote link (the URL) or a Find step (its store) names a reply from outside this list; the Replies tab then shows that reply's sub-thread
  useEffect(() => {
    if (environmentId !== undefined && threadId !== undefined && first !== null && request !== null)
      openSubThread({ environmentId, threadId }, first, true);
  }, [environmentId, threadId, first, request]);
}

/**
 * The main list and an open sub-thread are two views of one history. Each gets the quote link and
 * the Find match only when it shows that row, so the other does not wait or load history for it.
 * For a reply, the main list opens its sub-thread and leaves focus alone, since Find may have it.
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
  useOpenSubThread(threadRef, firstOf(citedId), cited?.key ?? null);
  useOpenSubThread(threadRef, firstOf(findId), find?.findNavigationId ?? null);
  return {
    citationRequest: cited != null && shows(citedId) ? cited : null,
    find: find === null || shows(findId) ? find : findWithoutMatch(find),
  };
}
