import {
  ComposerContextId,
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ProjectedTurnItem,
  type ReviewCommentContextRecord,
  TurnItemId,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../test/render";
import { ComposerPendingUserInputPanel } from "../components/chat/ComposerPendingUserInputPanel";
import {
  ComposerContextRecordsContext,
  ComposerContextReferenceChip,
  composerContextRecordsFromDraft,
} from "../components/composerContextPresentation";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import { ProposedPlanCard } from "../components/chat/ProposedPlanCard";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../session-logic";
import { reviewCommentContextId } from "../lib/composerContextRecords";
import { makeStreamingTimelineFixture } from "../test-fixtures";

const SAMPLE = "1~2 and 3~4, ~~gone~~";
const SHOWN = "1~2 and 3~4, gone";

const reviewComment: ReviewCommentContextRecord = {
  version: 1,
  kind: "review-comment",
  contextId: ComposerContextId.make("review-1"),
  label: "index.ts L4",
  sectionId: "diff-1",
  sectionTitle: "Changes",
  filePath: "src/index.ts",
  startIndex: 4,
  endIndex: 4,
  rangeLabel: "L4",
  text: SAMPLE,
  diff: "",
};

function thinkingAfter(from: OrchestrationV2ProjectedTurnItem): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make("live-thought");
  const { threadId, runId, ordinal, startedAt, updatedAt } = from.item;
  return {
    ...from,
    position: from.position + 1,
    sourceItemId: id,
    item: {
      id,
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "running",
      title: null,
      startedAt,
      completedAt: null,
      updatedAt,
      type: "reasoning",
      text: SAMPLE,
      streaming: true,
    },
  };
}

type Stage = "thinking" | "streaming" | "finished";

function singleTildeTimeline(stage: Stage) {
  const finished = stage === "finished";
  const fixture = makeStreamingTimelineFixture(SAMPLE);
  const [historyUser, historyWork, historyAssistant, liveUser, liveWork, liveAssistant] =
    fixture.visibleTurnItems;
  if (
    historyUser?.item.type !== "user_message" ||
    liveUser?.item.type !== "user_message" ||
    liveAssistant?.item.type !== "assistant_message"
  )
    throw new Error("Expected fixture messages");
  const items: OrchestrationV2ProjectedTurnItem[] = [
    { ...historyUser, item: { ...historyUser.item, text: SAMPLE } },
    historyWork!,
    historyAssistant!,
    {
      ...liveUser,
      item: {
        ...liveUser.item,
        text: formatComposerContextReference(reviewComment),
        context: { version: 1, records: [reviewComment] },
      },
    },
    liveWork!,
    stage === "thinking"
      ? thinkingAfter(liveWork!)
      : {
          ...liveAssistant,
          item: finished
            ? {
                ...liveAssistant.item,
                streaming: false,
                status: "completed",
                completedAt: liveAssistant.item.updatedAt,
              }
            : liveAssistant.item,
        },
  ];
  return (
    <MessagesTimeline
      timelineEntries={deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: items,
        optimisticMessages: [],
      })}
      isWorking={!finished}
      activeTurnStartedAt={fixture.time(5)}
      latestRun={{
        runId: fixture.runId,
        status: finished ? "completed" : "running",
        startedAt: fixture.time(5),
        completedAt: finished ? fixture.time(9) : null,
      }}
      listRef={createRef<LegendListRef | null>()}
      turnDiffSummaries={[]}
      runs={[]}
      routeThreadKey="environment-local:thread-single-tilde"
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
}

function expectSampleShown(body: Element | null | undefined) {
  expect(body?.textContent).toBe(SHOWN);
  expect([...body!.querySelectorAll("del")].map((node) => node.textContent)).toEqual(["gone"]);
}

// Collapsed thinking lines flatten all Markdown into plain label text.
function expectPreviewShown(body: Element | null | undefined) {
  expect(body?.textContent).toBe(SHOWN);
  expect(body!.querySelectorAll("del")).toHaveLength(0);
}

const messageBody = (container: HTMLElement, messageId: string) =>
  container.querySelector(`[data-message-id="${messageId}"] .chat-markdown`);

function renderTimeline(stage: Stage) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  return render(singleTildeTimeline(stage), { container });
}

describe("single tildes in the timeline", () => {
  it("strikes only double-tilde text in a sent message", async () => {
    await using screen = await renderTimeline("finished");
    await vi.waitFor(() => expectSampleShown(messageBody(screen.container, "history-user")));
  });

  it("strikes only double-tilde text in a review comment before it is sent", async () => {
    const records = composerContextRecordsFromDraft({
      terminalContexts: [],
      reviewComments: [{ ...reviewComment, id: "review-1" }],
    });
    await using screen = await render(
      <ComposerContextRecordsContext.Provider value={records}>
        <ComposerContextReferenceChip
          kind="review-comment"
          contextId={reviewCommentContextId("review-1")}
          label={reviewComment.label}
        />
      </ComposerContextRecordsContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Review comment, / }));
    await vi.waitFor(() =>
      expectSampleShown(page.getByRole("dialog").element().querySelector(".chat-markdown")),
    );
  });

  it("strikes only double-tilde text in a sent review comment", async () => {
    await using screen = await renderTimeline("finished");
    await userEvent.click(screen.getByRole("button", { name: /^Review comment, / }));
    await vi.waitFor(() =>
      expectSampleShown(page.getByRole("dialog").element().querySelector(".chat-markdown")),
    );
  });

  it("strikes only double-tilde text in an agent reply while streaming and after it finishes", async () => {
    await using screen = await renderTimeline("streaming");
    await vi.waitFor(() => expectSampleShown(messageBody(screen.container, "live-assistant")));
    await screen.rerender(singleTildeTimeline("finished"));
    await vi.waitFor(() => expectSampleShown(messageBody(screen.container, "live-assistant")));
  });

  it("keeps single tildes in a thinking line, collapsed and expanded", async () => {
    await using screen = await renderTimeline("thinking");
    const liveRow = () => screen.container.querySelector('[data-timeline-row-kind="work-live"]');
    await vi.waitFor(() => expectPreviewShown(liveRow()?.querySelector(".chat-markdown")));

    await userEvent.click(liveRow()!.querySelector("button")!);
    const thoughtRow = () =>
      screen.container.querySelector(
        '[data-timeline-row-kind="work"] [data-v2-item-type="reasoning"]',
      );
    await vi.waitFor(() => {
      expectPreviewShown(liveRow()?.querySelector(".chat-markdown"));
      expectPreviewShown(thoughtRow()?.querySelector(".chat-markdown"));
    });

    await userEvent.click(thoughtRow()!);
    await vi.waitFor(() =>
      expectSampleShown(
        screen.container.querySelector('[data-timeline-row-kind="work"] div.chat-markdown'),
      ),
    );
  });
});

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

describe("single tildes in plans and questions", () => {
  it("strikes only double-tilde text in a plan card, collapsed and expanded", async () => {
    const steps = Array.from({ length: 24 }, (_, index) => `- Step ${index + 1}`).join("\n");
    await using screen = await render(
      <ProposedPlanCard
        planMarkdown={`# Plan\n\n${SAMPLE}\n\n${steps}`}
        environmentId={threadRef.environmentId}
        cwd={undefined}
        workspaceRoot={undefined}
      />,
    );
    const firstParagraph = () => screen.container.querySelector(".chat-markdown p");
    await vi.waitFor(() => expectSampleShown(firstParagraph()));

    await userEvent.click(screen.getByRole("button", { name: "Expand plan" }));
    await expect.element(screen.getByRole("button", { name: "Collapse plan" })).toBeVisible();
    await vi.waitFor(() => expectSampleShown(firstParagraph()));
  });

  it("strikes only double-tilde text in the agent's pending question", async () => {
    await using screen = await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId: RuntimeRequestId.make("question-tilde"),
            createdAt: "2026-11-08T00:00:00.000Z",
            dismissible: false,
            responseCapability: "live",
            questions: [
              {
                id: "question-0",
                header: "Range",
                question: SAMPLE,
                options: [{ label: "Keep", description: "Keep the range" }],
                multiSelect: false,
              },
            ],
          },
        ]}
        cwd={undefined}
        threadRef={threadRef}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
        onDismiss={() => {}}
      />,
    );
    await vi.waitFor(() => expectSampleShown(screen.container.querySelector(".chat-markdown")));
  });
});
