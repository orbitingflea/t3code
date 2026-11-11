import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadSubThread } from "@t3tools/contracts";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";

import ChatView from "../../components/ChatView";
import { BackgroundThreadContext } from "../../components/chat/backgroundThread";
import { RelativeTime } from "../../components/RelativeTime";
import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { cn } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadDisplayMode } from "../displayMode/useThreadDisplayMode";
import {
  markSubThreadRead,
  type SubThreadSummary,
  SubThreadViewContext,
  unreadReplies,
  useSubThreadStates,
  useSubThreadSummaries,
  useSubThreadsStore,
} from "./subThreadsState";

const firstLine = (text: string) => text.trim().split("\n", 1)[0] ?? "";

/** The Replies tab: the list of the thread's sub-threads, or one of them with its reply box. */
export function SubThreadsPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  readonly parentPanel: SideChatParentPanel;
}) {
  const threadKey = scopedThreadKey(props.threadRef);
  const chosen = useSubThreadsStore((state) => state.shownByThreadKey[threadKey] ?? null);
  const hasSubThreads = useThreadDisplayMode(props.threadRef).subThreads;
  const summaries = useSubThreadSummaries(hasSubThreads ? props.threadRef : null);
  const states = useSubThreadStates(props.threadRef);
  const show = (first: string | null) => useSubThreadsStore.getState().show(threadKey, first);
  // Another device may switch the mode while this tab is open; no reply box works then.
  if (!hasSubThreads) {
    return (
      <p className="p-3 text-muted-foreground text-xs">This thread is not set to Chat + Replies.</p>
    );
  }
  // A rewind can remove the first message of the sub-thread on screen; the list takes its place.
  const shown = chosen !== null && summaries.has(chosen) ? chosen : null;
  if (shown === null) {
    return <SubThreadList summaries={summaries} states={states} onOpen={show} />;
  }
  return (
    <SubThreadView
      key={shown}
      threadRef={props.threadRef}
      first={shown}
      summary={summaries.get(shown)}
      states={states}
      visible={props.visible}
      parentPanel={props.parentPanel}
      onBack={() => show(null)}
    />
  );
}

function SubThreadList(props: {
  readonly summaries: ReadonlyMap<string, SubThreadSummary>;
  readonly states: ReadonlyMap<string, ThreadSubThread>;
  readonly onOpen: (first: string) => void;
}) {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const rows = [...props.summaries.values()]
    .filter((summary) => summary.replies > 0)
    .map((summary) => {
      const state = props.states.get(summary.first);
      return { summary, state, unread: unreadReplies(summary, props.states) };
    })
    .filter((row) => !unreadOnly || row.unread > 0)
    .toSorted((a, b) => Date.parse(b.summary.lastAt) - Date.parse(a.summary.lastAt));
  return (
    <div className="flex h-full min-h-0 flex-col" data-sub-thread-list>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-border border-b px-3 text-xs">
        {(["All", "Unread"] as const).map((label) => {
          const chosen = (label === "Unread") === unreadOnly;
          return (
            <button
              key={label}
              type="button"
              aria-pressed={chosen}
              onClick={() => setUnreadOnly(label === "Unread")}
              className={cn(
                "rounded-full border border-border px-2 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                chosen ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="p-3 text-muted-foreground text-xs">
            {unreadOnly
              ? "No unread replies."
              : "No replies yet. Point at a message in the chat and choose Reply."}
          </p>
        ) : (
          rows.map(({ summary, state, unread }) => (
            <button
              key={summary.first}
              type="button"
              onClick={() => props.onOpen(summary.first)}
              className="flex w-full flex-col gap-0.5 border-border border-b px-3 py-2 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent/50"
            >
              <span className="flex w-full items-baseline gap-1.5">
                <span
                  className={cn("min-w-0 flex-1 truncate text-sm", unread > 0 && "font-semibold")}
                >
                  {state?.summary || firstLine(summary.firstText)}
                </span>
                {unread > 0 ? (
                  <span className="shrink-0 rounded-full bg-info px-1.5 font-medium text-3xs text-white leading-4">
                    {unread}
                  </span>
                ) : null}
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  <RelativeTime timestamp={summary.lastAt} />
                </span>
              </span>
              <span className="w-full truncate text-muted-foreground text-xs">
                {summary.lastFrom === "user" ? "You: " : ""}
                {firstLine(summary.lastText)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function SubThreadView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly first: string;
  readonly summary: SubThreadSummary | undefined;
  readonly states: ReadonlyMap<string, ThreadSubThread>;
  readonly visible: boolean;
  readonly parentPanel: SideChatParentPanel;
  readonly onBack: () => void;
}) {
  const { threadRef, first, summary } = props;
  const state = props.states.get(first);
  const markRead = useAtomCommand(markSubThreadRead, { reportFailure: false });
  const latestReply = summary?.agentReplyTimes.at(-1);
  const unread = summary === undefined ? 0 : unreadReplies(summary, props.states);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records on the server that the user has this sub-thread's replies on screen
  useEffect(() => {
    if (!props.visible || unread === 0 || latestReply === undefined) return;
    void markRead({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, firstId: first, readAt: latestReply },
    });
  }, [props.visible, unread, latestReply, markRead, threadRef, first]);
  return (
    <div data-side-chat-pane data-sub-thread-view={first} className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-border border-b pr-3 pl-1">
        <button
          type="button"
          aria-label="All replies"
          onClick={props.onBack}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <span className="min-w-0 flex-1 truncate font-medium text-xs">
          {state?.summary || (summary === undefined ? "Replies" : firstLine(summary.firstText))}
        </span>
      </div>
      <SubThreadViewContext value={first}>
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              environmentId={threadRef.environmentId}
              threadId={threadRef.threadId}
              routeKind="server"
              embedded={props.parentPanel}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      </SubThreadViewContext>
    </div>
  );
}
