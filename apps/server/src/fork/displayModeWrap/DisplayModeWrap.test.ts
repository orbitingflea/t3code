import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  THREAD_HISTORY_INLINE_WORK_ITEM_LIMIT,
  THREAD_HISTORY_PAGE_POLICY,
} from "../../orchestration-v2/threadHistoryPaging.ts";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnControlService from "../../orchestration-v2/ProviderTurnControlService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as DisplayModeWrap from "./DisplayModeWrap.ts";

const sourceId = ThreadId.make("thread:display-wrap:source");
const forkId = ThreadId.make("thread:display-wrap:fork");
const deletedId = ThreadId.make("thread:display-wrap:deleted");
const foldedId = ThreadId.make("thread:display-wrap:folded");
const longId = ThreadId.make("thread:display-wrap:long");
const providerThreadId = ProviderThreadId.make("provider-thread:display-wrap");
const providerTurnId = ProviderTurnId.make("provider-turn:display-wrap");
const providerSessionId = ProviderSessionId.make("session:display-wrap");
const attemptId = RunAttemptId.make("attempt:display-wrap");
const runId = RunId.make("run:display-wrap");
const forkRunId = RunId.make("run:display-wrap:fork");
const nodeId = NodeId.make("node:display-wrap");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-6" };
const steerId = MessageId.make("message:display-wrap:steer");
const forkMessageId = MessageId.make("message:display-wrap:fork");

const store = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const settings = ServerSettings.layerTest({
  threadDisplayModes: {
    [sourceId]: "messages-only",
    [forkId]: "messages-only",
    [deletedId]: "messages-only",
    [foldedId]: "messages-only",
    [longId]: "messages-only",
  },
});
const providers = Layer.mock(ProviderRegistry.ProviderRegistry)({
  getProviders: Effect.succeed([
    {
      instanceId: providerInstanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [{ name: "compact" }],
      skills: [],
    },
  ]),
});
const wrapper = DisplayModeWrap.layer.pipe(
  Layer.provide(Layer.mergeAll(store, settings, providers)),
);

const threadCreated = (
  now: DateTime.Utc,
  id: ThreadId,
  forkedFrom: { readonly type: "run"; readonly threadId: ThreadId; readonly runId: RunId } | null,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`display-wrap:thread:${id}`),
  type: "thread.created",
  threadId: id,
  occurredAt: now,
  payload: {
    id,
    projectId: ProjectId.make("project:display-wrap"),
    title: "Display wrap",
    providerInstanceId,
    modelSelection,
    createdBy: "user",
    creationSource: "web",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/workspace",
    activeProviderThreadId: id === sourceId ? providerThreadId : null,
    lineage:
      forkedFrom === null
        ? { parentThreadId: null, relationshipToParent: null, rootThreadId: id }
        : { parentThreadId: sourceId, relationshipToParent: "fork", rootThreadId: sourceId },
    forkedFrom,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
});

const runCreated = (
  now: DateTime.Utc,
  threadId: ThreadId,
  id: RunId,
  status: "running" | "completed",
  ordinal = 1,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`display-wrap:run:${id}`),
  type: "run.created",
  threadId,
  occurredAt: now,
  payload: {
    id,
    threadId,
    ordinal,
    providerInstanceId,
    modelSelection,
    providerThreadId: threadId === sourceId ? providerThreadId : null,
    userMessageId: MessageId.make(`message:${id}`),
    rootNodeId: nodeId,
    activeAttemptId: threadId === sourceId ? attemptId : null,
    status,
    requestedAt: now,
    startedAt: now,
    completedAt: status === "completed" ? now : null,
    checkpointId: null,
    contextHandoffId: null,
  },
});

type ItemFields =
  | {
      readonly type: "user_message";
      readonly messageId: MessageId;
      readonly text: string;
      readonly inputIntent: "turn_start" | "steer";
    }
  | { readonly type: "send_to_user"; readonly text: string }
  | { readonly type: "command_execution" };

const itemUpdated = (
  now: DateTime.Utc,
  threadId: ThreadId,
  run: RunId,
  ordinal: number,
  fields: ItemFields,
): OrchestrationV2DomainEvent => {
  const base = {
    id: TurnItemId.make(`item:${threadId}:${ordinal}`),
    threadId,
    runId: run,
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
  };
  const payload: OrchestrationV2TurnItem =
    fields.type === "user_message"
      ? { ...base, ...fields, attachments: [], createdBy: "user", creationSource: "web" }
      : fields.type === "send_to_user"
        ? {
            ...base,
            type: "dynamic_tool",
            toolName: "mcp__t3-code__send_to_user",
            input: { text: fields.text },
          }
        : { ...base, type: "command_execution", input: "make test" };
  return {
    id: EventId.make(`display-wrap:item:${threadId}:${ordinal}`),
    type: "turn-item.updated",
    threadId,
    runId: run,
    nodeId,
    driver,
    occurredAt: now,
    payload,
  };
};

/** The source thread has a message, a sent reply, and then tool work that the user never saw. */
const seedSource = Effect.fn("seedSource")(function* (now: DateTime.Utc) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
    threadCreated(now, sourceId, null),
    runCreated(now, sourceId, runId, "running"),
    itemUpdated(now, sourceId, runId, 100, {
      type: "user_message",
      messageId: MessageId.make("message:display-wrap:first"),
      text: "Fix the build.",
      inputIntent: "turn_start",
    }),
    itemUpdated(now, sourceId, runId, 101, { type: "send_to_user", text: "On it." }),
    itemUpdated(now, sourceId, runId, 102, { type: "command_execution" }),
  ];
  yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
});

const steered: string[] = [];
const sessions = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
  get: () =>
    Effect.succeedSome({
      steerTurn: (input: { readonly message: { readonly text: string } }) =>
        Effect.sync(() => {
          steered.push(input.message.text);
        }),
    } as never),
});

const recap = (lines: ReadonlyArray<string>, text: string) =>
  [
    "<t3-messages-mode>",
    "This message is from the user. Other things happened in this thread since your last message to them, or since the thread began if you sent none. The user's screen showed:",
    ...lines,
    "</t3-messages-mode>",
    text,
  ].join("\n");

it.effect("wraps a steering message sent after the agent's hidden tool work", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* seedSource(now);
    const extra: ReadonlyArray<OrchestrationV2DomainEvent> = [
      {
        id: EventId.make("display-wrap:provider-thread"),
        type: "provider-thread.updated",
        threadId: sourceId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId,
          appThreadId: sourceId,
          ownerNodeId: null,
          nativeThreadRef: { driver, nativeId: "native-display-wrap", strength: "strong" },
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make("display-wrap:attempt"),
        type: "run-attempt.created",
        threadId: sourceId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
      {
        id: EventId.make("display-wrap:turn"),
        type: "provider-turn.updated",
        threadId: sourceId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: { driver, nativeId: "native-display-wrap-turn", strength: "strong" },
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
      {
        id: EventId.make("display-wrap:steer-message"),
        type: "message.updated",
        threadId: sourceId,
        occurredAt: now,
        payload: {
          id: steerId,
          threadId: sourceId,
          runId,
          nodeId,
          role: "user",
          text: "Use the smaller fix.",
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
        },
      },
      itemUpdated(now, sourceId, runId, 103, {
        type: "user_message",
        messageId: steerId,
        text: "Use the smaller fix.",
        inputIntent: "steer",
      }),
    ];
    yield* Effect.forEach(extra, (event) => projections.apply(event), { discard: true });

    const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
    yield* control.steer({
      threadId: sourceId,
      providerSessionId,
      providerThreadId,
      providerTurnId,
      messageId: steerId,
    });
    assert.deepEqual(steered, [
      recap(["[user] Fix the build.", "[you] On it."], "Use the smaller fix."),
    ]);
  }).pipe(
    Effect.provide(
      Layer.merge(
        store,
        ProviderTurnControlService.layer.pipe(
          Layer.provide(Layer.mergeAll(store, sessions, wrapper)),
        ),
      ),
    ),
  ),
);

it.effect("counts the history a fork inherits from its source", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* seedSource(now);
    const forkEvents: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, forkId, { type: "run", threadId: sourceId, runId }),
      runCreated(now, forkId, forkRunId, "running"),
      itemUpdated(now, forkId, forkRunId, 1_000_100, {
        type: "user_message",
        messageId: forkMessageId,
        text: "Try another way.",
        inputIntent: "turn_start",
      }),
    ];
    yield* Effect.forEach(forkEvents, (event) => projections.apply(event), { discard: true });
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const text = yield* wrap.wrapUserText({
      threadId: forkId,
      message: { id: forkMessageId, createdBy: "user", text: "Try another way." },
      text: "Try another way.",
    });
    assert.strictEqual(text, recap(["[user] Fix the build.", "[you] On it."], "Try another way."));
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect("wraps a message after tool work that history folds around a sent message", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const nextRunId = RunId.make("run:display-wrap:folded:next");
    const nextMessageId = MessageId.make("message:display-wrap:folded:next");
    // Each side of the sent message has enough commands for history to fold them all into one row.
    const half = THREAD_HISTORY_INLINE_WORK_ITEM_LIMIT / 2 + 1;
    const commands = (from: number) =>
      Array.from({ length: half }, (_, index) =>
        itemUpdated(now, foldedId, runId, from + index, { type: "command_execution" }),
      );
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, foldedId, null),
      runCreated(now, foldedId, runId, "completed"),
      itemUpdated(now, foldedId, runId, 1, {
        type: "user_message",
        messageId: MessageId.make("message:display-wrap:folded:first"),
        text: "Fix the build.",
        inputIntent: "turn_start",
      }),
      ...commands(2),
      itemUpdated(now, foldedId, runId, half + 2, { type: "send_to_user", text: "On it." }),
      ...commands(half + 3),
      runCreated(now, foldedId, nextRunId, "running", 2),
      itemUpdated(now, foldedId, nextRunId, 2 * half + 3, {
        type: "user_message",
        messageId: nextMessageId,
        text: "Any news?",
        inputIntent: "turn_start",
      }),
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const text = yield* wrap.wrapUserText({
      threadId: foldedId,
      message: { id: nextMessageId, createdBy: "user", text: "Any news?" },
      text: "Any news?",
    });
    assert.strictEqual(text, recap(["[user] Fix the build.", "[you] On it."], "Any news?"));
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect("wraps a message when the history window cuts off tool work with no sent message", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const firstRunId = RunId.make("run:display-wrap:long:0");
    // The thread has tool work and then more user turns than the window holds.
    // No turn in the thread has a sent message.
    const turns = Array.from(
      { length: THREAD_HISTORY_PAGE_POLICY.maxUserTurns + 2 },
      (_, index) => {
        const turnRunId = RunId.make(`run:display-wrap:long:${index + 1}`);
        return [
          runCreated(now, longId, turnRunId, "completed", index + 2),
          itemUpdated(now, longId, turnRunId, 10 * (index + 1), {
            type: "user_message",
            messageId: MessageId.make(`message:display-wrap:long:${index + 1}`),
            text: `Note ${index + 1}`,
            inputIntent: "turn_start",
          }),
        ];
      },
    ).flat();
    const lastMessageId = MessageId.make(
      `message:display-wrap:long:${THREAD_HISTORY_PAGE_POLICY.maxUserTurns + 2}`,
    );
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreated(now, longId, null),
      runCreated(now, longId, firstRunId, "completed"),
      itemUpdated(now, longId, firstRunId, 1, {
        type: "user_message",
        messageId: MessageId.make("message:display-wrap:long:0"),
        text: "Fix the build.",
        inputIntent: "turn_start",
      }),
      itemUpdated(now, longId, firstRunId, 2, { type: "command_execution" }),
      ...turns,
    ];
    yield* Effect.forEach(events, (event) => projections.apply(event), { discard: true });
    const wrap = yield* DisplayModeWrap.DisplayModeWrap;
    const text = yield* wrap.wrapUserText({
      threadId: longId,
      message: { id: lastMessageId, createdBy: "user", text: "Any news?" },
      text: "Any news?",
    });
    const count = THREAD_HISTORY_PAGE_POLICY.maxUserTurns;
    assert.strictEqual(
      text,
      recap(
        [`[user] Note ${count - 1}`, `[user] Note ${count}`, `[user] Note ${count + 1}`],
        "Any news?",
      ),
    );
  }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect(
  "sends the provider's slash commands unchanged and wraps other text that starts with /",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedSource(now);
      const wrap = yield* DisplayModeWrap.DisplayModeWrap;
      const sendAt = Effect.fn("sendAt")(function* (ordinal: number, text: string) {
        const id = MessageId.make(`message:display-wrap:${ordinal}`);
        yield* projections.apply(
          itemUpdated(now, sourceId, runId, ordinal, {
            type: "user_message",
            messageId: id,
            text,
            inputIntent: "steer",
          }),
        );
        return yield* wrap.wrapUserText({
          threadId: sourceId,
          message: { id, createdBy: "user", text },
          text,
        });
      });
      assert.strictEqual(yield* sendAt(103, "/compact"), "/compact");
      assert.strictEqual(
        yield* sendAt(104, "/tmp is full"),
        recap(["[user] Fix the build.", "[you] On it.", "[user] /compact"], "/tmp is full"),
      );
    }).pipe(Effect.provide(Layer.merge(store, wrapper))),
);

it.effect("drops the mode of a deleted thread and keeps the others", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    yield* projections.apply(threadCreated(now, sourceId, null));
    yield* projections.apply(threadCreated(now, deletedId, null));
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET deleted_at = ${DateTime.formatIso(now)} WHERE thread_id = ${deletedId}`;
    yield* DisplayModeWrap.pruneDeletedThreadModes();
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    assert.deepEqual((yield* serverSettings.getSettings).threadDisplayModes, {
      [sourceId]: "messages-only",
      [forkId]: "messages-only",
      [foldedId]: "messages-only",
      [longId]: "messages-only",
    });
  }).pipe(Effect.provide(Layer.merge(store, settings))),
);
