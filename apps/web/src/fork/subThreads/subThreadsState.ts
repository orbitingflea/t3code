import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { isCompleteTurnItemRow } from "@t3tools/client-runtime/state/threads";
import {
  type ScopedThreadRef,
  THREAD_SUB_THREADS_WS_METHODS,
  type ThreadSubThread,
} from "@t3tools/contracts";
import { createContext, use } from "react";
import { create } from "zustand";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useRightPanelStore } from "../../rightPanelStore";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { useQuietThreadVisibleTurnItems } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { timelineSubThreads } from "../displayMode/displayModeTimeline";

const threadSubThreads = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:thread-sub-threads",
  tag: THREAD_SUB_THREADS_WS_METHODS.subscribe,
});

export const markSubThreadRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:thread-sub-threads:mark-read",
  tag: THREAD_SUB_THREADS_WS_METHODS.markRead,
});

/** What the loaded history shows of one sub-thread. */
export interface SubThreadSummary {
  /** The id of the sub-thread's first message, which is its row in the main list. */
  readonly first: string;
  readonly firstFrom: "user" | "agent";
  readonly firstText: string;
  readonly replies: number;
  /** The activity time of its latest message: when it was sent, or last edited. */
  readonly lastAt: string;
  readonly lastFrom: "user" | "agent";
  readonly lastText: string;
  /** The activity time of each of the agent's replies (send, or latest edit), in message order. */
  readonly agentReplyTimes: ReadonlyArray<string>;
}

export type SubThreadSummaries = ReadonlyMap<string, SubThreadSummary>;

const NO_SUMMARIES: SubThreadSummaries = new Map();

interface SubThreadsStore {
  /** The sub-thread that each thread's Replies tab shows. Without one, the tab shows the list. */
  readonly shownByThreadKey: Readonly<Record<string, string>>;
  readonly show: (threadKey: string, first: string | null) => void;
}

export const useSubThreadsStore = create<SubThreadsStore>((set) => ({
  shownByThreadKey: {},
  show: (threadKey, first) =>
    set((state) => {
      const { [threadKey]: _removed, ...rest } = state.shownByThreadKey;
      return { shownByThreadKey: first === null ? rest : { ...rest, [threadKey]: first } };
    }),
}));

type QuietItems = ReturnType<typeof useQuietThreadVisibleTurnItems>;
// The latest summaries of each thread, so every reader of one thread shares one fold, and a
// summary that did not change keeps its identity. A few threads are enough: one main list each.
const latestSummaries = new Map<string, { items: QuietItems; summaries: SubThreadSummaries }>();
const LATEST_SUMMARIES_KEPT = 8;

function summariesOf(threadKey: string, items: QuietItems): SubThreadSummaries {
  const known = latestSummaries.get(threadKey);
  if (known?.items === items) return known.summaries;
  const summaries = timelineSubThreads(
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: items.filter(isCompleteTurnItemRow),
      optimisticMessages: [],
    }),
    known?.summaries ?? null,
  );
  latestSummaries.delete(threadKey);
  latestSummaries.set(threadKey, { items, summaries });
  for (const oldest of latestSummaries.keys()) {
    if (latestSummaries.size <= LATEST_SUMMARIES_KEPT) break;
    latestSummaries.delete(oldest);
  }
  return summaries;
}

/**
 * The thread's sub-threads by the id of their first message, or none for a null thread. They come
 * from the thread's structure, which holds through streamed text, so a text delta redraws nothing.
 */
export function useSubThreadSummaries(threadRef: ScopedThreadRef | null): SubThreadSummaries {
  const items = useQuietThreadVisibleTurnItems(threadRef);
  return threadRef === null ? NO_SUMMARIES : summariesOf(scopedThreadKey(threadRef), items);
}

/**
 * Opens the thread's Replies tab on one sub-thread, or on the list with `first` null. With
 * `automatic`, the user did not ask for the tab, so keyboard focus stays where it is.
 */
export function openSubThread(
  threadRef: ScopedThreadRef,
  first: string | null,
  automatic = false,
): void {
  useSubThreadsStore.getState().show(scopedThreadKey(threadRef), first);
  useRightPanelStore.getState().open(threadRef, "replies", automatic);
}

/**
 * The id of the first message of the sub-thread that a chat view shows. A view inside this context
 * lists only that sub-thread, and a message sent from it is a reply there. Null is the main list.
 */
export const SubThreadViewContext = createContext<string | null>(null);

/**
 * Whether this chat view is a sub-thread's. Such a view is a second view of its thread, so what the
 * thread keeps once (its model and modes, the Find position) stays with the main view.
 */
export const useInSubThreadView = () => use(SubThreadViewContext) !== null;

export const NO_STATES: ReadonlyMap<string, ThreadSubThread> = new Map();
const statesBySnapshot = new WeakMap<
  ReadonlyArray<ThreadSubThread>,
  ReadonlyMap<string, ThreadSubThread>
>();

/** The server's read time and summary of each sub-thread, by first message id. Not loaded: NO_STATES. */
export function useSubThreadStates(
  threadRef: ScopedThreadRef,
): ReadonlyMap<string, ThreadSubThread> {
  const { environmentId, threadId } = threadRef;
  const snapshot = useEnvironmentQuery(threadSubThreads({ environmentId, input: { threadId } }))
    .data?.subThreads;
  if (snapshot === undefined) return NO_STATES;
  let states = statesBySnapshot.get(snapshot);
  if (states === undefined) {
    states = new Map(snapshot.map((subThread) => [subThread.firstId, subThread]));
    statesBySnapshot.set(snapshot, states);
  }
  return states;
}

/**
 * How many of the agent's replies are newer than the user's last read, given the server's states.
 * Before the server's first answer nothing counts, so a thread does not open with every reply new.
 */
export function unreadReplies(
  summary: SubThreadSummary,
  states: ReadonlyMap<string, ThreadSubThread>,
): number {
  if (states === NO_STATES) return 0;
  const readAt = states.get(summary.first)?.readAt;
  return readAt == null
    ? summary.agentReplyTimes.length
    : summary.agentReplyTimes.filter((time) => Date.parse(time) > Date.parse(readAt)).length;
}
