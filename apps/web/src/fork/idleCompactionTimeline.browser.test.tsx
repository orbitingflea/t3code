import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  WHILE_IDLE_COMPACTION_ID_PREFIX,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../test/render";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import { deriveMessagesTimelineRows } from "../components/chat/MessagesTimeline.logic";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../session-logic";
import { makeStreamingTimelineFixture } from "../test-fixtures";

// The compaction's wire marker stays "beforeCacheExpires"; only its message id names the idle level.
function whileIdleCompaction() {
  const fixture = makeStreamingTimelineFixture();
  const [history0, history1, history2, liveUser, , liveAssistant] = fixture.visibleTurnItems;
  if (liveUser?.item.type !== "user_message" || liveAssistant?.item.type !== "assistant_message")
    throw new Error("Expected live fixture items");
  const prompt: OrchestrationV2ProjectedTurnItem = {
    ...liveUser,
    item: {
      ...liveUser.item,
      messageId: MessageId.make(`${WHILE_IDLE_COMPACTION_ID_PREFIX}thread:run`),
      text: "/compact",
      idleCompaction: "beforeCacheExpires",
    },
  };
  const assistantItem = liveAssistant.item;
  const compaction = (completed: boolean): OrchestrationV2ProjectedTurnItem => ({
    ...liveAssistant,
    item: {
      ...assistantItem,
      type: "compaction" as const,
      driver: null,
      beforeTokenCount: 899_000,
      ...(completed
        ? { status: "completed" as const, afterTokenCount: 19_000 }
        : { status: "running" as const }),
    },
  });
  const latestRun = (completed: boolean) => ({
    runId: fixture.runId,
    status: completed ? ("completed" as const) : ("running" as const),
    startedAt: fixture.time(5),
    completedAt: completed ? fixture.time(9) : null,
  });
  const entries = (live: OrchestrationV2ProjectedTurnItem[]) =>
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [history0!, history1!, history2!, ...live],
      optimisticMessages: [],
    });
  return { fixture, prompt, compaction, latestRun, entries };
}

describe("whileIdle compaction in the timeline", () => {
  it("shows one live status, then a divider titled for the idle level", () => {
    const { fixture, prompt, compaction, latestRun, entries } = whileIdleCompaction();
    const liveRows = (live: OrchestrationV2ProjectedTurnItem[], completed = false) => {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: entries(live),
        isWorking: !completed,
        runningRunId: fixture.runId,
        latestRun: latestRun(completed),
        activeTurnStartedAt: fixture.time(5),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      return rows.slice(rows.findIndex((row) => row.id.includes("history-assistant")) + 1);
    };

    for (const live of [[prompt], [prompt, compaction(false)]]) {
      expect(liveRows(live)).toMatchObject([
        { kind: "context-compaction", active: true, label: "Compacting while idle…" },
      ]);
    }
    expect(liveRows([prompt, compaction(true)], true)).toMatchObject([
      {
        kind: "context-compaction",
        active: false,
        title: "Context automatically compacted while idle",
        tokenCounts: { before: "899K", after: "19K" },
      },
    ]);
  });

  it("renders the idle level's live divider and finished token delta", async () => {
    const { fixture, prompt, compaction, latestRun, entries } = whileIdleCompaction();
    const ui = (completed: boolean) => (
      <MessagesTimeline
        timelineEntries={entries([prompt, compaction(completed)])}
        isWorking={!completed}
        isCompacting={!completed}
        activeTurnStartedAt={fixture.time(5)}
        latestRun={latestRun(completed)}
        listRef={createRef<LegendListRef | null>()}
        turnDiffSummaries={[]}
        runs={[]}
        routeThreadKey="environment-local:thread-while-idle"
        onOpenTurnDiff={() => {}}
        onOpenThread={() => {}}
        onForkFromRun={async () => {}}
        supportsConversationRollback={false}
        onRevertToTurnCount={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        activeThreadEnvironmentId={EnvironmentId.make("environment-local")}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        anchorMessageId={null}
        onAnchorReady={() => {}}
        onAnchorSizeChanged={() => {}}
        contentInsetEndAdjustment={0}
        emptyPlaceholderInset={0}
        liveFollowEnabled
        onIsAtEndChange={() => {}}
      />
    );
    const container = document.createElement("div");
    container.style.cssText =
      "height: 1200px; width: 900px; display: flex; flex-direction: column;";
    await using screen = await render(ui(false), { container });
    await expect
      .element(screen.getByRole("separator", { name: "Compacting while idle…" }))
      .toBeVisible();
    expect(container.textContent).not.toContain("/compact");
    expect(container.textContent).not.toContain("Thinking");
    expect(container.textContent).not.toContain("Working");
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
    await screen.rerender(ui(true));
    await expect
      .element(
        screen.getByRole("separator", {
          name: "Context automatically compacted while idle 899K → 19K tokens",
        }),
      )
      .toBeVisible();
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("Compacting while idle…");
  });
});
