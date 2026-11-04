import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { LegendListRef } from "@legendapp/list/react";
import { MESSAGES_ONLY_DISPLAY_MODE, NORMAL_DISPLAY_MODE } from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";
import { createRef, type ComponentProps } from "react";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { MessagesTimeline } from "../../components/chat/MessagesTimeline";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { applyDisplayMode } from "./displayModeTimeline";

const threadId = ThreadId.make("display-mode-thread");
const runId = RunId.make("display-mode-run");
const time = (second: number) => new Date(Date.UTC(2026, 10, 3, 0, 0, second)).toISOString();
const base = (id: string, second: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
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
const userMessage = (id: string, second: number, text: string, extra = {}) => ({
  ...base(id, second),
  type: "user_message" as const,
  messageId: MessageId.make(id),
  text,
  attachments: [],
  inputIntent: "turn_start" as const,
  createdBy: "user" as const,
  creationSource: "web" as const,
  ...extra,
});

const items: OrchestrationV2TurnItem[] = [
  userMessage("ask", 0, "Please fix the login bug."),
  { ...base("thinking", 1), type: "reasoning", text: "Looking at auth code", streaming: false },
  {
    ...base("read", 2),
    type: "dynamic_tool",
    toolName: "Read",
    input: { path: "a.ts" },
    output: "x",
  },
  { ...base("run", 3), type: "command_execution", input: "vp test", output: "ok", exitCode: 0 },
  {
    ...base("draft", 4),
    type: "assistant_message",
    messageId: MessageId.make("draft"),
    text: "I found the cause in the token check.",
    streaming: false,
  },
  {
    ...base("sent", 5),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__send_to_user",
    input: { text: "Fixed: the token check now allows clock skew." },
    output: { ok: true, message: "Shown to the user." },
  },
  userMessage("bot", 6, "Status from the build bot", {
    createdBy: "agent",
    senderThreadId: ThreadId.make("bot-thread"),
  }),
];
const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = items.map((item, position) => ({
  position,
  visibility: "local",
  sourceThreadId: threadId,
  sourceItemId: item.id,
  item,
}));
const entries = deriveTimelineEntriesFromVisibleTurnItems({
  visibleTurnItems,
  optimisticMessages: [],
});

type TimelineProps = ComponentProps<typeof MessagesTimeline>;

function props(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:display-mode-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
  };
}

async function renderTimeline(timelineEntries: TimelineProps["timelineEntries"]) {
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 800px; display: flex; flex-direction: column;";
  return render(<MessagesTimeline {...props()} timelineEntries={timelineEntries} />, {
    container,
  });
}

describe("Messages only timeline", () => {
  it("shows the person's message and the sent message, drawn as a reply", async () => {
    await using screen = await renderTimeline([
      ...applyDisplayMode(MESSAGES_ONLY_DISPLAY_MODE, entries),
    ]);
    await expect
      .element(screen.getByText("Fixed: the token check now allows clock skew."))
      .toBeVisible();
    const text = screen.container.textContent ?? "";
    expect(text).toContain("Please fix the login bug.");
    expect(text).toContain("T3 Code");
    for (const hidden of [
      "I found the cause in the token check.",
      "Status from the build bot",
      "vp test",
      "to the user",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("keeps every row in Normal", async () => {
    expect(applyDisplayMode(NORMAL_DISPLAY_MODE, entries)).toBe(entries);
    await using screen = await renderTimeline([...entries]);
    await expect.element(screen.getByText("I found the cause in the token check.")).toBeVisible();
    expect(screen.container.textContent).toContain("Status from the build bot");
  });
});
