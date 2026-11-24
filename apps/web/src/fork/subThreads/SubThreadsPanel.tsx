import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadSubThread } from "@t3tools/contracts";
import { type ReactNode, use, useEffect, useRef, useState } from "react";

import ChatView from "../../components/ChatView";
import { BackgroundThreadContext } from "../../components/chat/backgroundThread";
import type { ChatComposerHandle } from "../../components/chat/ChatComposer";
import { RelativeTime } from "../../components/RelativeTime";
import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { cn } from "../../lib/utils";
import { useQuietThreadProjection, useThreadHistory } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadDisplayMode } from "../displayMode/useThreadDisplayMode";
import { WORK_AREA_COPY } from "../forkCopy";
import {
  type ChatFileOpener,
  chatFileTarget,
  hostShownChat,
  type OpenOrigin,
  OpenOriginContext,
} from "../workArea/chatFileOpener";
import { replyPanelLink } from "../workArea/linkSources";
import { panelDragProps } from "../workArea/panelLinkDrag";
import { ReplyTabContext } from "../workArea/tabStrip";
import { useThreadGone } from "../workArea/useThreadGone";
import { type ReplyEntry, surfaceTabId } from "../workArea/workArea.logic";
import { registerReplyBox } from "./subThreadCite";
import {
  firstLine,
  markSubThreadRead,
  type SubThreadSummary,
  SubThreadViewContext,
  unreadReplies,
  useSubThreadStates,
  useSubThreadSummaries,
} from "./subThreadsState";

// Another thread's code never runs in the owner's terminal, as for a secondary Chat.
const NO_PARENT_PANEL: SideChatParentPanel = {};

/** The Replies tab, the list of the thread's sub-threads; or a reply tab, one of them. */
export function SubThreadsPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  readonly parentPanel: SideChatParentPanel;
}) {
  const entry = use(ReplyTabContext);
  if (entry !== null) {
    return (
      <SubThreadTab
        key={entry.id}
        owner={props.threadRef}
        entry={entry}
        visible={props.visible}
        parentPanel={props.parentPanel}
      />
    );
  }
  return <RepliesList threadRef={props.threadRef} />;
}

const LIST_ORIGIN: OpenOrigin = { kind: "own", tab: surfaceTabId("replies"), adjacent: true };

function RepliesList(props: { readonly threadRef: ScopedThreadRef }) {
  const hasSubThreads = useThreadDisplayMode(props.threadRef).subThreads;
  const summaries = useSubThreadSummaries(hasSubThreads ? props.threadRef : null);
  const states = useSubThreadStates(props.threadRef);
  // Another device may switch the mode while this tab is open; no reply box works then.
  if (!hasSubThreads) {
    return <p className="p-3 text-muted-foreground text-xs">{WORK_AREA_COPY.notChatMode}</p>;
  }
  return (
    <SubThreadList
      threadRef={props.threadRef}
      summaries={summaries}
      states={states}
      opener={() => chatFileTarget(LIST_ORIGIN, props.threadRef)}
    />
  );
}

/** One sub-thread as a work-area tab, of the owner's thread or of another one. */
function SubThreadTab(props: {
  readonly owner: ScopedThreadRef;
  readonly entry: ReplyEntry;
  readonly visible: boolean;
  readonly parentPanel: SideChatParentPanel;
}) {
  const { owner, entry } = props;
  const { thread, first } = entry.reply;
  const tab = surfaceTabId(entry.id);
  const own = scopedThreadKey(owner) === scopedThreadKey(thread);
  const { environmentId: ownerEnvironmentId, threadId: ownerThreadId } = owner;
  const { environmentId, threadId } = thread;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- routes another thread's panel actions to the owner's layout while its reply tab is shown, as a secondary Chat does
  useEffect(
    () =>
      own
        ? undefined
        : hostShownChat(
            scopeThreadRef(environmentId, threadId),
            scopeThreadRef(ownerEnvironmentId, ownerThreadId),
          ),
    [own, environmentId, threadId, ownerEnvironmentId, ownerThreadId],
  );
  const origin: OpenOrigin = own
    ? { kind: "own", tab }
    : { kind: "shown", owner: scopeThreadRef(ownerEnvironmentId, ownerThreadId), tab };
  const gone = useThreadGone(thread);
  const settingsLoaded =
    useAtomValue(serverEnvironment.settingsValueAtom(thread.environmentId)) !== null;
  const syncError = useAtomValue(environmentThreadDetails.errorAtom(thread));
  const hasSubThreads = useThreadDisplayMode(thread).subThreads;
  const summaries = useSubThreadSummaries(hasSubThreads ? thread : null);
  const states = useSubThreadStates(thread);
  const loaded = useQuietThreadProjection(thread) !== null;
  const history = useThreadHistory(thread);
  const summary = summaries.get(first);
  const frame = (body: ReactNode) => (
    <div data-reply-tab={tab} className="@container/chat flex h-full min-h-0 flex-col">
      {body}
    </div>
  );
  const note = (text: string) => frame(<p className="p-3 text-muted-foreground text-xs">{text}</p>);
  if (gone === null || !settingsLoaded) return note(WORK_AREA_COPY.loadingSubThread);
  if (gone) return note(WORK_AREA_COPY.missingThread);
  if (!hasSubThreads) return note(WORK_AREA_COPY.notChatMode);
  if (summary !== undefined) {
    return frame(
      <OpenOriginContext value={origin}>
        <SubThreadView
          threadRef={thread}
          entry={entry}
          first={first}
          summary={summary}
          states={states}
          visible={props.visible}
          parentPanel={own ? props.parentPanel : NO_PARENT_PANEL}
        />
      </OpenOriginContext>,
    );
  }
  if (!loaded) return note(syncError ?? WORK_AREA_COPY.loadingSubThread);
  // Only a fully loaded history tells a removed first message from an older one.
  if (history.hasMoreHistory || history.error !== null)
    return frame(<EarlierHistory threadRef={thread} />);
  return note(WORK_AREA_COPY.subThreadRemoved);
}

/** A reply tab whose first message is in an older page of the thread's history. */
function EarlierHistory(props: { readonly threadRef: ScopedThreadRef }) {
  return (
    <div className="flex flex-col">
      <p className="px-3 pt-3 text-muted-foreground text-xs">{WORK_AREA_COPY.subThreadNotLoaded}</p>
      <LoadEarlier threadRef={props.threadRef} />
    </div>
  );
}

function LoadEarlier(props: { readonly threadRef: ScopedThreadRef }) {
  const history = useThreadHistory(props.threadRef);
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier replies",
    reportFailure: false,
  });
  if (!history.hasMoreHistory && history.error === null) return null;
  return (
    <div className="flex flex-col items-start gap-1 px-3 py-2 text-muted-foreground text-xs">
      {history.error !== null ? <p role="status">{history.error}</p> : null}
      {history.hasMoreHistory ? (
        <button
          type="button"
          disabled={history.loading}
          onClick={() =>
            void loadEarlier({
              environmentId: props.threadRef.environmentId,
              input: { threadId: props.threadRef.threadId },
            })
          }
          className="rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
        >
          {history.loading ? "Loading earlier messages…" : "Load earlier messages"}
        </button>
      ) : null}
    </div>
  );
}

function SubThreadList(props: {
  readonly threadRef: ScopedThreadRef;
  readonly summaries: ReadonlyMap<string, SubThreadSummary>;
  readonly states: ReadonlyMap<string, ThreadSubThread>;
  readonly opener: ChatFileOpener;
}) {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const loaded = useQuietThreadProjection(props.threadRef) !== null;
  const syncError = useAtomValue(environmentThreadDetails.errorAtom(props.threadRef));
  const history = useThreadHistory(props.threadRef);
  const emptyText = unreadOnly
    ? "No unread replies."
    : !loaded
      ? (syncError ?? "Loading replies…")
      : history.hasMoreHistory
        ? "No replies in the loaded messages."
        : "No replies yet. Point at one of the agent's messages and choose Reply.";
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
          <p role="status" className="p-3 text-muted-foreground text-xs">
            {emptyText}
          </p>
        ) : (
          rows.map(({ summary, state, unread }) => (
            <button
              key={summary.first}
              type="button"
              onClick={() => props.opener().openSubThread(summary.first)}
              {...panelDragProps(() => replyPanelLink(props.opener, summary.first))}
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
        {loaded ? <LoadEarlier threadRef={props.threadRef} /> : null}
      </div>
    </div>
  );
}

function SubThreadView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly entry: ReplyEntry;
  readonly first: string;
  readonly summary: SubThreadSummary;
  readonly states: ReadonlyMap<string, ThreadSubThread>;
  readonly visible: boolean;
  readonly parentPanel: SideChatParentPanel;
}) {
  const { threadRef, entry, first, summary } = props;
  const state = props.states.get(first);
  const markRead = useAtomCommand(markSubThreadRead, { reportFailure: false });
  const latestReply = summary.agentReplyTimes.at(-1);
  const unread = unreadReplies(summary, props.states);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records on the server that the user has this sub-thread's replies on screen
  useEffect(() => {
    if (!props.visible || unread === 0 || latestReply === undefined) return;
    void markRead({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, firstId: first, readAt: latestReply },
    });
  }, [props.visible, unread, latestReply, markRead, threadRef, first]);
  const composer = useRef<ChatComposerHandle | null>(null);
  const threadKey = scopedThreadKey(threadRef);
  const box = useRef<ReturnType<typeof registerReplyBox> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells a Cite in the main list which reply boxes are on screen
  useEffect(() => {
    const registered = registerReplyBox(entry, threadKey, first, composer);
    box.current = registered;
    return () => registered[Symbol.dispose]();
  }, [entry, threadKey, first]);
  return (
    <div
      data-side-chat-pane
      data-sub-thread-view={first}
      className="flex h-full min-h-0 flex-col"
      onFocusCapture={() => box.current?.focused()}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-border border-b px-3">
        <span className="min-w-0 flex-1 truncate font-medium text-xs">
          {state?.summary || firstLine(summary.firstText)}
        </span>
      </div>
      <SubThreadViewContext value={first}>
        <BackgroundThreadContext value>
          <ComposerHandleContext value={composer}>
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
