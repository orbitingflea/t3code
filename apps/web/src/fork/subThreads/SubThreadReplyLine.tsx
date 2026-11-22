import type { ScopedThreadRef } from "@t3tools/contracts";
import { ReplyIcon } from "lucide-react";
import { use } from "react";

import { type TimelineRow, TimelineRowCtx } from "../../components/chat/timelineRowContext";
import { RelativeTime } from "../../components/RelativeTime";
import { cn } from "../../lib/utils";
import { useThreadDisplayMode } from "../displayMode/useThreadDisplayMode";
import {
  openSubThread,
  type SubThreadSummary,
  SubThreadViewContext,
  unreadReplies,
  useSubThreadStates,
  useSubThreadSummaries,
} from "./subThreadsState";

/** The sub-thread that the row `rowId` starts, in the main list of a thread with sub-threads. */
function useRowSubThread(rowId: string) {
  const { threadRef } = use(TimelineRowCtx);
  const inMainList =
    useThreadDisplayMode(threadRef).subThreads && use(SubThreadViewContext) === null;
  const summary = useSubThreadSummaries(inMainList ? threadRef : null).get(rowId);
  return threadRef === null || summary === undefined ? null : { threadRef, summary };
}

/**
 * Directly under a first message that has replies, above the row's time and actions, so the line
 * reads as part of that message: how many replies, how many are unread, when the latest came and
 * what they are about. Any other row gets nothing.
 */
export function SubThreadReplyLine(props: {
  readonly rowId: string;
  readonly fromUser: boolean;
  /**
   * When the row draws nothing under the line: always, or only in a wide lane, where a user's row
   * that is grouped with the next one moves its actions beside the bubble. The line then keeps
   * its own distance from the next message.
   */
  readonly bare?: "always" | "wide" | undefined;
}) {
  const subThread = useRowSubThread(props.rowId);
  if (subThread === null || subThread.summary.replies === 0) return null;
  return <ReplyLine {...subThread} fromUser={props.fromUser} bare={props.bare} />;
}

function ReplyLine(props: {
  readonly threadRef: ScopedThreadRef;
  readonly summary: SubThreadSummary;
  readonly fromUser: boolean;
  readonly bare: "always" | "wide" | undefined;
}) {
  const { threadRef, summary } = props;
  const states = useSubThreadStates(threadRef);
  const state = states.get(summary.first);
  const unread = unreadReplies(summary, states);
  return (
    // A user's row spaces its parts itself; an agent's row does not.
    <div
      className={cn(
        "flex max-w-full",
        !props.fromUser && "mt-1",
        props.bare === "always" && "mb-4",
        props.bare === "wide" && "@min-[37rem]:mb-4",
      )}
    >
      <button
        type="button"
        onClick={() => openSubThread(threadRef, summary.first)}
        data-sub-thread-reply-line={summary.first}
        className="flex min-w-0 max-w-full flex-col items-start gap-0.5 rounded-r-md border-border border-l-2 py-0.5 pr-2 pl-2 text-left text-xs outline-none hover:border-info hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="flex items-center gap-1.5">
          <span className="font-medium text-info-foreground">
            {summary.replies} {summary.replies === 1 ? "reply" : "replies"}
          </span>
          {unread > 0 ? (
            <span className="rounded-full bg-info px-1.5 font-medium text-3xs text-white leading-4">
              {unread} new
            </span>
          ) : null}
          <span className="text-muted-foreground tabular-nums">
            <RelativeTime timestamp={summary.lastAt} />
          </span>
        </span>
        {state?.summary ? (
          <span className="max-w-full truncate text-muted-foreground">{state.summary}</span>
        ) : null}
      </button>
    </div>
  );
}

/**
 * Height of the Reply slot with a mouse. The Reply button is 16px tall, and the list clips
 * anything outside the row, so the slot is 16px minus the row's bottom padding. For an agent
 * message with no meta row (the Copy and time line), TimelineRowContent sets pb-1 (4px) when
 * grouped with the next row and pb-2 (8px) otherwise, giving h-3 or h-2.
 */
const fineSlotHeight = (row: Extract<TimelineRow, { kind: "message" }>) =>
  row.groupedWithNext ? "h-3" : "h-2";

/**
 * Reply button under an agent's main-list message with no replies yet and no meta row (the line
 * with Copy and the time). Rows with a meta row use SubThreadMetaReply instead. With a mouse, it
 * shows on row hover or focus and sits in the row's bottom padding plus a slot. On touch, it
 * always shows with its own height so it clears the next row.
 */
export function SubThreadReplyButton(props: {
  readonly row: Extract<TimelineRow, { kind: "message" }>;
}) {
  const subThread = useRowSubThread(props.row.id);
  if (
    subThread === null ||
    props.row.message.role === "user" ||
    props.row.showAssistantMeta ||
    subThread.summary.replies > 0
  )
    return null;
  const { threadRef, summary } = subThread;
  return (
    <div className={cn("relative flex pointer-coarse:h-auto", fineSlotHeight(props.row))}>
      <button
        type="button"
        onClick={() => openSubThread(threadRef, summary.first)}
        className="absolute top-0 left-0 z-10 inline-flex items-center gap-1 rounded-md bg-background px-1.5 text-muted-foreground text-xs opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset group-hover/assistant:opacity-100 pointer-coarse:static pointer-coarse:py-0.5 pointer-coarse:opacity-100"
      >
        <ReplyIcon className="size-3" />
        Reply
      </button>
    </div>
  );
}

/**
 * Reply button at the end of an agent message's meta row, right of the time. It renders only when
 * that message starts a main-list sub-thread with no replies yet. It has no visibility rules of
 * its own. It shows and hides with the meta row.
 */
export function SubThreadMetaReply(props: { readonly messageId: string }) {
  const subThread = useRowSubThread(props.messageId);
  if (subThread === null || subThread.summary.replies > 0) return null;
  const { threadRef, summary } = subThread;
  return (
    // As tall as the meta row's xs buttons, in the time's 12px text at every width.
    <button
      type="button"
      onClick={() => openSubThread(threadRef, summary.first)}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground text-xs outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:h-6"
    >
      <ReplyIcon className="size-3" />
      Reply
    </button>
  );
}
