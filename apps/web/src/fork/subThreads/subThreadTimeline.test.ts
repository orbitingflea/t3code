import {
  ComposerContextId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  CHAT_REPLIES_DISPLAY_MODE,
  MESSAGES_ONLY_DISPLAY_MODE,
  shortId,
  SUB_THREAD_RECORD_KIND,
} from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { type ComposerThreadDraftState, useComposerDraftStore } from "../../composerDraftStore";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import {
  applyDisplayMode,
  rowShownIn,
  subThreadOfReply,
  timelineSubThreads,
} from "../displayMode/displayModeTimeline";
import {
  choiceDraftTarget,
  composerDraftView,
  subThreadDraftKey,
  threadOfSubThreadDraft,
} from "./subThreadDraft";
import { addsContext, subThreadDraftId, withSubThreadRecord } from "./subThreadReply";
import { NO_STATES, unreadReplies } from "./subThreadsState";

const EMPTY: ComposerThreadDraftState = {
  prompt: "",
  images: [],
  files: [],
  nonPersistedImageIds: [],
  persistedAttachments: [],
  terminalContexts: [],
  previewAnnotations: [],
  reviewComments: [],
  threadContexts: [],
  environmentContexts: [],
  replyTo: null,
  modelSelectionByProvider: {},
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
};
const threadId = ThreadId.make("sub-thread-timeline");
const time = (second: number) => new Date(Date.UTC(2026, 10, 11, 0, 0, second)).toISOString();
const base = (id: string, second: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: RunId.make("run"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: second,
  status: "completed" as const,
  title: null,
  startedAt: DateTime.makeUnsafe(time(second)),
  completedAt: DateTime.makeUnsafe(time(second)),
  updatedAt: DateTime.makeUnsafe(time(second)),
});
const typed = (id: string, second: number, text: string, under?: string) =>
  ({
    ...base(id, second),
    type: "user_message",
    messageId: MessageId.make(id),
    text,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
    ...(under === undefined ? {} : { context: withSubThreadRecord(under, "", undefined) }),
  }) as OrchestrationV2TurnItem;
const sent = (id: string, second: number, input: Record<string, unknown>) =>
  ({
    ...base(id, second),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__send_to_user",
    input,
    output: { ok: true },
  }) satisfies OrchestrationV2TurnItem;

const entriesOf = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: items.map((item, position): OrchestrationV2ProjectedTurnItem => ({
      position,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    })),
    optimisticMessages: [],
  });

// The user's question with an answer and a follow-up, and the agent's news with one reply.
const items = [
  typed("q1", 0, "Is the build green?"),
  sent("news", 1, { text: "The deploy is done.", new_sub_thread: true }),
  { ...base("work", 2), type: "reasoning" as const, text: "checking", streaming: false },
  sent("a1", 3, { text: "Yes, all checks pass.", reply_to: shortId("q1"), user_message: "x" }),
  typed("why", 4, "Which build?", "news"),
  typed("q2", 5, "And the lint job?", "q1"),
  sent("a2", 6, { text: "Lint passes too.", reply_to: shortId("q2"), user_message: "x" }),
];
const entries = entriesOf(items);
const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);

describe("Chat + Replies rows", () => {
  it("draws only the first messages in the main list", () => {
    expect(ids(applyDisplayMode(CHAT_REPLIES_DISPLAY_MODE, entries))).toEqual(["q1", "news"]);
  });

  it("draws a sub-thread as its first message and its replies", () => {
    expect(ids(applyDisplayMode(CHAT_REPLIES_DISPLAY_MODE, entries, "q1"))).toEqual([
      "q1",
      "a1",
      "q2",
      "a2",
    ]);
    expect(ids(applyDisplayMode(CHAT_REPLIES_DISPLAY_MODE, entries, "news"))).toEqual([
      "news",
      "why",
    ]);
  });

  it("stays a flat list in Messages only", () => {
    expect(ids(applyDisplayMode(MESSAGES_ONLY_DISPLAY_MODE, entries))).toEqual([
      "q1",
      "news",
      "a1",
      "why",
      "q2",
      "a2",
    ]);
  });
});

describe("subThreadOfReply", () => {
  it("names the sub-thread that a quote link or a Find step must open for a reply", () => {
    expect(subThreadOfReply(entries, "a2")).toBe("q1");
    expect(subThreadOfReply(entries, "why")).toBe("news");
    // A first message is in the main list, and other rows are in no sub-thread.
    expect(subThreadOfReply(entries, "q1")).toBeNull();
    expect(subThreadOfReply(entries, "work")).toBeNull();
    expect(subThreadOfReply(entries, "gone")).toBeNull();
  });
});

describe("rowShownIn", () => {
  it("says which view shows a row, so only that view scrolls to a Find match or a quote", () => {
    // A reply shows in its sub-thread only; a first message in the main list and in its own sub-thread.
    expect(rowShownIn(entries, "a2", null)).toBe("elsewhere");
    expect(rowShownIn(entries, "a2", "q1")).toBe("here");
    expect(rowShownIn(entries, "a2", "news")).toBe("elsewhere");
    expect(rowShownIn(entries, "q1", null)).toBe("here");
    expect(rowShownIn(entries, "q1", "q1")).toBe("here");
    expect(rowShownIn(entries, "q1", "news")).toBe("elsewhere");
    // A row that is not loaded yet may still be loaded, by the main list.
    expect(rowShownIn(entries, "gone", null)).toBe("unknown");
    expect(rowShownIn(entries, "gone", "q1")).toBe("unknown");
  });
});

describe("timelineSubThreads", () => {
  it("counts each sub-thread's replies and names its latest message", () => {
    const summaries = timelineSubThreads(entries, null);
    expect(summaries.get("q1")).toMatchObject({
      firstFrom: "user",
      replies: 3,
      lastFrom: "agent",
      lastText: "Lint passes too.",
      lastAt: time(6),
      agentReplyTimes: [time(3), time(6)],
    });
    expect(summaries.get("news")).toMatchObject({
      firstFrom: "agent",
      replies: 1,
      lastFrom: "user",
      agentReplyTimes: [],
    });
  });

  it("keeps each unchanged summary, and the whole result when nothing changed", () => {
    const before = timelineSubThreads(entries, null);
    const hiddenWork = entriesOf([
      ...items,
      { ...base("more", 7), type: "reasoning" as const, text: "still checking", streaming: false },
    ]);
    expect(timelineSubThreads(hiddenWork, before)).toBe(before);
    const oneMore = timelineSubThreads(
      entriesOf([...items, typed("thanks", 8, "Thanks.", "news")]),
      before,
    );
    expect(oneMore).not.toBe(before);
    expect(oneMore.get("q1")).toBe(before.get("q1"));
    expect(oneMore.get("news")?.replies).toBe(2);
  });

  it("counts as unread the agent's replies after the user's last read", () => {
    const summary = timelineSubThreads(entries, null).get("q1")!;
    const readAt = (at: string | null) =>
      new Map([["q1", { firstId: "q1", readAt: at, summary: null }]]);
    expect(unreadReplies(summary, new Map())).toBe(2);
    expect(unreadReplies(summary, readAt(null))).toBe(2);
    expect(unreadReplies(summary, readAt(time(3)))).toBe(1);
    expect(unreadReplies(summary, readAt(time(6)))).toBe(0);
    // Before the server's first answer, the read times are unknown and nothing shows as new.
    expect(unreadReplies(summary, NO_STATES)).toBe(0);
  });
});

describe("withSubThreadRecord", () => {
  it("adds the reply record after the message's own records", () => {
    expect(withSubThreadRecord(null, "hi", undefined)).toBeUndefined();
    const reply = withSubThreadRecord("news", "hi", undefined);
    // A slash command acts on the whole thread; a path at the start of a reply is not one.
    expect(withSubThreadRecord("news", "/compact", undefined)).toBeUndefined();
    expect(withSubThreadRecord("news", " /goal ship it", undefined)).toBeUndefined();
    expect(withSubThreadRecord("news", "/usr/bin is missing", undefined)).toBeDefined();
    expect(reply?.records).toMatchObject([
      { kind: SUB_THREAD_RECORD_KIND, payload: { first: "news" } },
    ]);
    // Approval feedback takes no added context, and a reply alone adds none.
    expect(addsContext(undefined)).toBe(false);
    expect(addsContext(reply)).toBe(false);
    expect(
      addsContext(
        withSubThreadRecord("news", "hi", {
          version: 1,
          records: [
            {
              version: 1,
              contextId: ComposerContextId.make("terminal"),
              kind: "terminal",
              label: "Terminal",
              payload: {},
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("a reply box's draft", () => {
  const draft = (prompt: string, runtimeMode: ComposerThreadDraftState["runtimeMode"] = null) =>
    ({ ...EMPTY, prompt, runtimeMode }) satisfies ComposerThreadDraftState;
  const key = subThreadDraftKey("env-1:mcp:thread:1", "turn:item/1");

  it("names its thread, and no other key does", () => {
    expect(key.startsWith("env-1:")).toBe(true);
    expect(threadOfSubThreadDraft(key)).toEqual({
      environmentId: "env-1",
      threadId: "mcp:thread:1",
    });
    expect(threadOfSubThreadDraft("env-1:mcp:thread:1")).toBeNull();
    expect(choiceDraftTarget(key)).toEqual({ environmentId: "env-1", threadId: "mcp:thread:1" });
    expect(choiceDraftTarget("draft-1")).toBe("draft-1");
  });

  it("shows its own text with its thread's model and modes", () => {
    const own = draft("a reply");
    const view = (thread: ComposerThreadDraftState | null, mine = own) =>
      composerDraftView(key, mine, () => thread, EMPTY);
    expect(view(null)).toBe(own);
    const supervised = view(draft("main text", "approval-required"));
    expect(supervised).toMatchObject({ prompt: "a reply", runtimeMode: "approval-required" });
    // Typing in the main box changes its draft but not its choices: the view stays the same object.
    expect(view(draft("main text, longer", "approval-required"))).toBe(supervised);
    expect(view(draft("main text", "full-access"))).not.toBe(supervised);
    // With nothing typed and no choice made, there is no draft, as for any other composer.
    expect(composerDraftView(key, null, () => draft("main text"), EMPTY)).toBeNull();
    expect(
      composerDraftView("env-1:mcp:thread:1", own, () => draft("x", "full-access"), EMPTY),
    ).toBe(own);
  });

  it("stores a mode set in the reply box with the thread, and its text with itself", () => {
    const store = useComposerDraftStore.getState();
    const thread = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("t-1") };
    const reply = subThreadDraftId("env-1:t-1", "m-1")!;
    store.setPrompt(reply, "a reply");
    store.setRuntimeMode(reply, "approval-required");
    expect(store.getComposerDraft(thread)).toMatchObject({
      prompt: "",
      runtimeMode: "approval-required",
    });
    expect(store.getComposerDraft(reply)).toMatchObject({
      prompt: "a reply",
      runtimeMode: "approval-required",
    });
    expect(useComposerDraftStore.getState().draftsByThreadKey[reply]?.runtimeMode).toBeNull();
    store.clearDraftThread(thread);
    expect(useComposerDraftStore.getState().draftsByThreadKey[reply]).toBeUndefined();
  });
});
