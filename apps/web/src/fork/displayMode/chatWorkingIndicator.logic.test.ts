import {
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { notificationTurnItem } from "@t3tools/provider-core/server/notification";
import { shortId } from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { withSubThreadRecord } from "../subThreads/subThreadReply";
import {
  type IndicatorRun,
  scrollToEndBottom,
  showsWorkingIndicator,
  workingForText,
} from "./chatWorkingIndicator.logic";
import { runPlaces } from "./displayModeTimeline";

const threadId = ThreadId.make("working-indicator-thread");
const time = (second: number) => new Date(Date.UTC(2026, 10, 21, 0, 0, second)).toISOString();
const base = (id: string, second: number, run: string) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: RunId.make(run),
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
const message = (id: string, second: number, run: string, under?: string, extra = {}) =>
  ({
    ...base(id, second, run),
    type: "user_message",
    messageId: MessageId.make(id),
    text: id,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
    ...(under === undefined ? {} : { context: withSubThreadRecord(under, "", undefined) }),
    ...extra,
  }) as OrchestrationV2TurnItem;
const answer = (id: string, second: number, run: string, replyTo: string) =>
  ({
    ...base(id, second, run),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__send_to_user",
    input: { text: `answer ${id}`, reply_to: shortId(replyTo), user_message: "x" },
    output: { ok: true },
  }) satisfies OrchestrationV2TurnItem;
const wake = notificationTurnItem(
  message("wake", 3, "wake-run"),
  {
    notification: {
      source: { kind: "delegated_task", taskIds: [NodeId.make("task-1")] },
      outcome: "completed",
      summary: "Delegated task finished",
    },
  },
  [],
);

const items = [
  message("q1", 0, "main-run"),
  answer("a1", 1, "main-run", "q1"),
  message("f1", 2, "reply-run", "q1"),
  wake,
  message("task", 4, "task-run", "q1", { scheduledTaskId: ScheduledTaskId.make("daily") }),
  message("bot", 5, "agent-run", "q1", { senderThreadId: ThreadId.make("other-thread") }),
  message("to-f-main", 6, "to-reply-run"),
  message("to-f-steer", 7, "to-reply-run", "q1"),
  message("to-main-reply", 8, "to-main-run", "q1"),
  message("to-main-steer", 9, "to-main-run"),
  message("orphan", 10, "orphan-run", "not-loaded"),
];
const entries = deriveTimelineEntriesFromVisibleTurnItems({
  visibleTurnItems: items.map((item, position): OrchestrationV2ProjectedTurnItem => ({
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  })),
  optimisticMessages: [],
});
const places = runPlaces(entries);

const live = (run: string, status: IndicatorRun["status"] = "running"): IndicatorRun => ({
  runId: RunId.make(run),
  status,
  startedAt: time(0),
  completedAt: null,
});
type Inputs = Omit<Parameters<typeof showsWorkingIndicator>[0], "places" | "view">;
const working: Inputs = {
  working: true,
  localSendPending: false,
  activityRun: null,
  runtime: null,
};
/** The views that show the line, given each view's own inputs. */
const shownIn = (main: Partial<Inputs>, reply: Partial<Inputs> = main) =>
  [
    showsWorkingIndicator({ ...working, ...main, places, view: null }) && "main",
    showsWorkingIndicator({ ...working, ...reply, places, view: "q1" }) && "q1",
  ].filter(Boolean);

describe("showsWorkingIndicator", () => {
  it("shows the line where the live run answers", () => {
    expect(shownIn({ activityRun: live("reply-run") })).toEqual(["q1"]);
    expect(shownIn({ activityRun: live("main-run") })).toEqual(["main"]);
    // A wake has no typed message, so the run answers in the main list from its start.
    expect(shownIn({ activityRun: live("wake-run", "starting") })).toEqual(["main"]);
    expect(shownIn({ activityRun: live("task-run") })).toEqual(["main"]);
    expect(shownIn({ activityRun: live("agent-run") })).toEqual(["main"]);
    expect(shownIn({ activityRun: live("orphan-run") })).toEqual(["main"]);
  });

  it("moves with the latest message the user typed in the run", () => {
    expect(shownIn({ activityRun: live("to-reply-run") })).toEqual(["q1"]);
    expect(shownIn({ activityRun: live("to-main-run", "waiting") })).toEqual(["main"]);
  });

  it("shows a pending send in the view that sent it until the run has a place", () => {
    expect(shownIn({ working: false }, { localSendPending: true })).toEqual(["q1"]);
    // A steer from the sub-thread joins a run that answers in the main list until the server places it.
    expect(
      shownIn(
        { activityRun: live("main-run") },
        { activityRun: live("main-run"), localSendPending: true },
      ),
    ).toEqual(["main"]);
  });

  it("hides a queued run until its message lands, and shows any other unplaced run in main", () => {
    expect(shownIn({ activityRun: live("next-run", "queued") })).toEqual([]);
    expect(shownIn({ activityRun: live("next-run", "starting") })).toEqual(["main"]);
    expect(shownIn({ activityRun: live("next-run") })).toEqual(["main"]);
    expect(shownIn({ working: false, activityRun: live("reply-run") })).toEqual([]);
  });
});

describe("scrollToEndBottom", () => {
  it("keeps Normal's height and lifts Chat's button above the reserved row", () => {
    expect(scrollToEndBottom(30, 120, 0)).toBe(34);
    expect(scrollToEndBottom(30, 120, 28)).toBe(152);
  });
});

describe("workingForText", () => {
  it("counts whole seconds from the start in English units", () => {
    const environmentId = EnvironmentId.make("working-indicator-environment");
    const start = Date.UTC(2026, 10, 21, 0, 0, 0);
    const at = (elapsedMs: number) =>
      workingForText(new Date(start).toISOString(), environmentId, start + elapsedMs);
    expect(at(0)).toBe("Working for 0s");
    expect(at(-5_000)).toBe("Working for 0s");
    expect(at(59_900)).toBe("Working for 59s");
    expect(at(65_400)).toBe("Working for 1m 5s");
    expect(workingForText("not a time", environmentId, start)).toBe("Working for 0s");
  });
});
