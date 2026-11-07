import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { THREAD_HISTORY_INLINE_WORK_ITEM_LIMIT } from "../../orchestration-v2/threadHistoryPaging.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-6" };
const nodeId = NodeId.make("node:send-to-user-history");

const layer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

/**
 * Seeds one finished turn and returns the ordinal of its folded row. The turn has the user's message,
 * a tool call at ordinal 2, and then enough commands for the history window to fold the tool work.
 */
const seedTurn = Effect.fn("seedTurn")(function* (threadId: ThreadId, toolName: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const runId = RunId.make(`run:${threadId}`);
  yield* store.apply({
    id: EventId.make(`event:${threadId}:thread`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      projectId: ProjectId.make("project:send-to-user-history"),
      title: "Send to user history",
      providerInstanceId,
      modelSelection,
      createdBy: "user",
      creationSource: "web",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* store.apply({
    id: EventId.make(`event:${threadId}:run`),
    type: "run.created",
    threadId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${threadId}`),
      rootNodeId: nodeId,
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  const base = (ordinal: number) => ({
    id: TurnItemId.make(`item:${threadId}:${ordinal}`),
    threadId,
    runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });
  const items: ReadonlyArray<OrchestrationV2TurnItem> = [
    {
      ...base(1),
      type: "user_message",
      messageId: MessageId.make(`message:${threadId}`),
      inputIntent: "turn_start",
      text: "Fix the build.",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    { ...base(2), type: "dynamic_tool", toolName, input: { text: "On it." } },
    ...Array.from(
      { length: THREAD_HISTORY_INLINE_WORK_ITEM_LIMIT + 1 },
      (_, index): OrchestrationV2TurnItem => ({
        ...base(index + 3),
        type: "command_execution",
        input: "make test",
      }),
    ),
  ];
  yield* Effect.forEach(
    items,
    (payload) =>
      store.apply({
        id: EventId.make(`event:${threadId}:item:${payload.ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId,
        driver,
        occurredAt: now,
        payload,
      }),
    { discard: true },
  );
  const window = yield* store.getThreadSnapshotWindow(threadId, {
    rowLimit: 77,
    userTurnLimit: 10,
    deferWork: true,
  });
  return window.projection.visibleTurnItems.find((row) => row.item.deferredWork)?.item.ordinal;
});

it.effect("keeps a sent message out of the folded tool work", () =>
  Effect.gen(function* () {
    // The folded row sits at the first folded item. It starts at 3 only when the call at 2 keeps its own row.
    assert.strictEqual(
      yield* seedTurn(ThreadId.make("thread:sent"), "mcp__t3-code__send_to_user"),
      3,
    );
    assert.strictEqual(yield* seedTurn(ThreadId.make("thread:other"), "mcp__other__lookup"), 2);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps a replace_send_to_user call out of the folded tool work, like a send", () =>
  Effect.gen(function* () {
    assert.strictEqual(
      yield* seedTurn(ThreadId.make("thread:replaced"), "mcp__t3-code__replace_send_to_user"),
      3,
    );
  }).pipe(Effect.provide(layer)),
);
