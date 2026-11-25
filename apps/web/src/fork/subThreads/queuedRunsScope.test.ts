import {
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { shortId } from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { runPlaces, timelineSubThreads } from "../displayMode/displayModeTimeline";
import { queuedRunPlace } from "./queuedRunsScope";
import { withSubThreadRecord } from "./subThreadReply";

const threadId = ThreadId.make("queued-scope-thread");
const at = DateTime.makeUnsafe("2026-11-23T00:00:00.000Z");
const userMessage = (id: string, ordinal: number, text: string, extra: object = {}) =>
  ({
    id: TurnItemId.make(id),
    threadId,
    runId: RunId.make(`${id}-run`),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "user_message",
    messageId: MessageId.make(id),
    text,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
    ...extra,
  }) as OrchestrationV2TurnItem;
const inReplyBox = (first: string, text: string) => ({
  context: withSubThreadRecord(first, text, undefined),
});

// Each case is a message as its queued run holds it; it then starts as the run's only message.
const cases: ReadonlyArray<readonly [string, string, object]> = [
  ["typed in the main list", "Run the tests", {}],
  ["typed in a loaded sub-thread", "And the lint job?", inReplyBox("first", "And the lint job?")],
  ["typed under an unloaded first", "Still there?", inReplyBox("not-loaded", "Still there?")],
  ["a slash command from a reply box", "/compact", inReplyBox("first", "/compact")],
  [
    "sent by another agent",
    "Review finished.",
    { createdBy: "agent", creationSource: "mcp", senderThreadId: ThreadId.make("lead") },
  ],
  [
    "sent by a scheduled task",
    "Nightly check.",
    { createdBy: "agent", scheduledTaskId: ScheduledTaskId.make("nightly") },
  ],
  ["a wake", "/compact", { idleCompaction: true }],
];

function timeline(extra: OrchestrationV2TurnItem, base = [userMessage("first", 0, "Ship it")]) {
  const items = [...base, extra];
  return deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: items.map((item, position): OrchestrationV2ProjectedTurnItem => ({
      position,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    })),
    optimisticMessages: [],
  });
}

describe("queuedRunPlace", () => {
  it.each(cases)("puts a queued message %s where its started run answers", (_, text, extra) => {
    const entries = timeline(userMessage("queued", 1, text, extra));
    const started = entries.find(
      (entry) => entry.kind === "message" && entry.message.id === "queued",
    );
    if (started?.kind !== "message") throw new Error("the queued message has no row");
    const loaded = timelineSubThreads(entries, null);
    expect(queuedRunPlace(started.message as never, (first) => loaded.has(first))).toBe(
      runPlaces(entries).get(RunId.make("queued-run")) ?? null,
    );
  });

  it("puts a reply in its sub-thread and everything else in the main list", () => {
    const places = cases.map(([name, text, extra]) => {
      const entries = timeline(userMessage("queued", 1, text, extra));
      const started = entries.find(
        (entry) => entry.kind === "message" && entry.message.id === "queued",
      );
      const loaded = timelineSubThreads(entries, null);
      const message = started?.kind === "message" ? started.message : undefined;
      return [name, queuedRunPlace(message as never, (first) => loaded.has(first))] as const;
    });
    expect(Object.fromEntries(places)).toEqual({
      "typed in the main list": null,
      "typed in a loaded sub-thread": "first",
      "typed under an unloaded first": null,
      "a slash command from a reply box": null,
      "sent by another agent": null,
      "sent by a scheduled task": null,
      "a wake": null,
    });
  });

  it("puts a run with no loaded message in the main list", () => {
    expect(queuedRunPlace(undefined, () => true)).toBeNull();
  });

  it("keeps a queued reply in the main list while its sub-thread has no row to open", () => {
    // The answer replies to a question outside the loaded history; a reply under it places it.
    const answer = {
      ...userMessage("answer", 0, ""),
      type: "dynamic_tool",
      toolName: "mcp__t3-code__send_to_user",
      input: { text: "Done.", reply_to: shortId("not-loaded"), user_message: "x" },
      output: { ok: true },
    } as unknown as OrchestrationV2TurnItem;
    const entries = timeline(
      userMessage("queued", 1, "Which one?", inReplyBox("answer", "Which one?")),
      [answer],
    );
    const started = entries.find(
      (entry) => entry.kind === "message" && entry.message.id === "queued",
    );
    if (started?.kind !== "message") throw new Error("the queued message has no row");
    const loaded = timelineSubThreads(entries, null);
    // Without the reply in the history, the answer has no row, so no reply box can show the reply.
    const history = timeline(userMessage("other", 1, "Unrelated"), [answer]);
    const reachable = timelineSubThreads(history, null);
    expect(queuedRunPlace(started.message as never, (first) => reachable.has(first))).toBeNull();
    // Once the reply runs, its row places the answer, and the run answers in that sub-thread.
    expect(loaded.has("answer")).toBe(true);
    expect(runPlaces(entries).get(RunId.make("queued-run"))).toBe("answer");
  });
});
