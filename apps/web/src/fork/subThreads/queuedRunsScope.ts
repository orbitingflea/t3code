import type { QueuedThreadRun } from "@t3tools/client-runtime/state/thread-workflows";
import { getUserQueuedThreadRuns } from "@t3tools/client-runtime/state/thread-workflows";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  OrchestrationMessageContext,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { displayEventFromMessage, subThreadOfRecords } from "@t3tools/shared/displayModes";
import { use } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import type { DraftId } from "../../composerDraftStore";
import { readThreadDisplay, useThreadDisplayMode } from "../displayMode/useThreadDisplayMode";
import { subThreadDraftId } from "./subThreadReply";
import {
  readSubThreadSummaries,
  SubThreadViewContext,
  useSubThreadSummaries,
} from "./subThreadsState";

type QueuedMessage = QueuedThreadRun["message"];
type QueueProjection = Parameters<typeof getUserQueuedThreadRuns>[0];

/**
 * Returns the view where the queued run for `message` will answer, matching `runPlaces`.
 * Returns the sub-thread first message id for a reply the user typed if `loaded` is true for it.
 * Returns `null` for the main list on missing, slash, agent, task, wake, guest, and other messages.
 */
export function queuedRunPlace(
  message: QueuedMessage,
  loaded: (first: string) => boolean,
): string | null {
  const event = message === undefined ? null : displayEventFromMessage(message);
  return event?.type === "user" && event.under !== undefined && loaded(event.under)
    ? event.under
    : null;
}

/**
 * Returns a predicate for whether the current `SubThreadViewContext` view lists a queued run.
 * When `threadRef`'s mode has sub-threads, it accepts defined messages `queuedRunPlace` maps to
 * that view using loaded sub-thread first messages. It rejects `undefined`, so no view shows a run
 * until its message arrives while the sending view keeps its pending row. Other modes accept all.
 */
export function useShowsQueuedRun(
  threadRef: ScopedThreadRef | null,
): (message: QueuedMessage) => boolean {
  const mode = useThreadDisplayMode(threadRef);
  const view = use(SubThreadViewContext);
  const summaries = useSubThreadSummaries(mode.subThreads ? threadRef : null);
  return (message) =>
    !mode.subThreads ||
    (message !== undefined && queuedRunPlace(message, (first) => summaries.has(first)) === view);
}

/**
 * Returns `count` of queued runs this view lists in `projection`. `ownsEdit(context)` checks edit
 * ownership from the reply record and loaded sub-threads, so ownership stays when the run leaves
 * the queue. Without sub-threads, this view owns all edits. `recoveryTarget(context)` returns the
 * message box for unsaved edit text when the run leaves, or `undefined` if `threadRef` is `null`.
 */
export function useQueuedRunsInView(
  threadRef: ScopedThreadRef | null,
  projection: QueueProjection | null,
): {
  readonly count: number;
  readonly ownsEdit: (context: OrchestrationMessageContext | undefined) => boolean;
  readonly recoveryTarget: (
    context: OrchestrationMessageContext | undefined,
  ) => ScopedThreadRef | DraftId | undefined;
} {
  const showsMessage = useShowsQueuedRun(threadRef);
  const mode = useThreadDisplayMode(threadRef);
  const view = use(SubThreadViewContext);
  const summaries = useSubThreadSummaries(mode.subThreads ? threadRef : null);
  const runs = projection === null ? [] : getUserQueuedThreadRuns(projection);
  const messages = new Map(
    runs.length === 0 ? [] : (projection?.messages ?? []).map((message) => [message.id, message]),
  );
  return {
    count: runs.filter((run) => showsMessage(messages.get(run.userMessageId))).length,
    ownsEdit: (context) =>
      !mode.subThreads || recordPlace(context, (first) => summaries.has(first)) === view,
    recoveryTarget: (context) => (threadRef === null ? undefined : editHome(threadRef, context)),
  };
}

/**
 * Returns `steer` and `edit` shortcut labels from `keybindings` for queued message tooltips.
 * Returns `null` for both in a sub-thread view, because queue keyboard shortcuts do not run there.
 */
export function useQueueShortcutLabels(keybindings: ResolvedKeybindingsConfig): {
  readonly steer: string | null;
  readonly edit: string | null;
} {
  const inSubThread = use(SubThreadViewContext) !== null;
  return {
    steer: inSubThread
      ? null
      : shortcutLabelForCommand(keybindings, "thread.steerQueuedMessage", {
          context: { terminalFocus: false },
        }),
    edit: inSubThread
      ? null
      : shortcutLabelForCommand(keybindings, "thread.editQueuedMessage", {
          context: { composerFocus: true },
        }),
  };
}

/**
 * Returns `messages` in the main list and `undefined` in a sub-thread view.
 * Guest messages are not replies and belong only to the main list.
 */
export function useGuestMessagesInView<T>(messages: T | undefined): T | undefined {
  return use(SubThreadViewContext) === null ? messages : undefined;
}

/**
 * Returns the message box showing a queued edit when its run leaves the queue. Uses the reply box
 * of the sub-thread in `context`'s reply record when `threadRef`'s mode has sub-threads and loaded
 * history shows that sub-thread, or `threadRef`, the main box. The edit hook puts unsaved text back.
 */
function editHome(
  threadRef: ScopedThreadRef,
  context: OrchestrationMessageContext | undefined,
): ScopedThreadRef | DraftId {
  if (!readThreadDisplay(threadRef).mode.subThreads) return threadRef;
  const summaries = readSubThreadSummaries(threadRef);
  const first = recordPlace(context, (id) => summaries.has(id));
  return first === null
    ? threadRef
    : (subThreadDraftId(scopedThreadKey(threadRef), first) ?? threadRef);
}

/**
 * Returns the first message id of the sub-thread named by `context`'s reply record when `loaded`
 * is true for that id, or `null` for the main list. Queued-message edit ownership and edit
 * recovery both use it so they agree on where an edited message lives.
 */
function recordPlace(
  context: OrchestrationMessageContext | undefined,
  loaded: (first: string) => boolean,
): string | null {
  const first = subThreadOfRecords(context?.records);
  return first !== undefined && loaded(first) ? first : null;
}

/**
 * Tooltip on a disabled queued-message pencil while another message box of the thread owns an
 * open edit. A thread keeps one queued-message edit open at a time.
 */
export const QUEUE_EDIT_OPEN_ELSEWHERE =
  "Save or cancel the queued message edit in another message box first.";
