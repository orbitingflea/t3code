import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { planWorkerThreadPrune, pruneWorkerThreads } from "./workerThreadPrune.ts";

const layer = EventSink.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
      Layer.provideMerge(SqlitePersistence.layerMemory),
    ),
  ),
);

const at = (iso: string) => DateTime.makeUnsafe(iso);
const NOW = "2026-11-06T12:00:00.000Z";
const OLD = "2026-10-20T12:00:00.000Z";
const RECENT = "2026-11-04T12:00:00.000Z";
const provider = ProviderInstanceId.make("codex");

type Lineage = OrchestrationV2AppThread["lineage"];
const topLevel = (id: string): Lineage => ({
  parentThreadId: null,
  relationshipToParent: null,
  rootThreadId: ThreadId.make(id),
});
const childOf = (parent: string, relationship: "subagent" | "fork"): Lineage => ({
  parentThreadId: ThreadId.make(parent),
  relationshipToParent: relationship,
  rootThreadId: ThreadId.make(parent),
});

function threadEvents(
  id: string,
  options: {
    readonly lineage: Lineage;
    readonly creationSource: OrchestrationV2AppThread["creationSource"];
    readonly lastActivity: string;
    readonly runStatus: OrchestrationV2Run["status"];
    readonly createdAt?: string;
  },
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = ThreadId.make(id);
  const created = at(options.createdAt ?? OLD);
  const runId = RunId.make(`run:${id}`);
  return [
    {
      type: "thread.created",
      id: EventId.make(`event:${id}:created`),
      threadId,
      occurredAt: created,
      payload: {
        createdBy: options.lineage.parentThreadId === null ? "user" : "agent",
        creationSource: options.creationSource,
        id: threadId,
        projectId: ProjectId.make("project:prune"),
        title: id,
        providerInstanceId: provider,
        modelSelection: { instanceId: provider, model: "gpt-6.1" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: options.lineage,
        forkedFrom: null,
        createdAt: created,
        updatedAt: created,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
    {
      type: "run.created",
      id: EventId.make(`event:${id}:run`),
      threadId,
      runId,
      occurredAt: created,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: provider,
        modelSelection: { instanceId: provider, model: "gpt-6.1" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${id}:1`),
        rootNodeId: null,
        activeAttemptId: null,
        status: options.runStatus,
        queuePosition: null,
        requestedAt: created,
        startedAt: created,
        completedAt: options.runStatus === "running" ? null : created,
        checkpointId: null,
        contextHandoffId: null,
      },
    },
    message(id, 1, options.lastActivity),
  ];
}

function message(id: string, ordinal: number, time: string): OrchestrationV2DomainEvent {
  const threadId = ThreadId.make(id);
  return {
    type: "message.updated",
    id: EventId.make(`event:${id}:message:${ordinal}`),
    threadId,
    providerInstanceId: provider,
    occurredAt: at(time),
    payload: {
      createdBy: "agent",
      creationSource: "provider",
      id: MessageId.make(`message:${id}:${ordinal}`),
      threadId,
      runId: null,
      nodeId: null,
      role: "assistant",
      text: `reply ${ordinal}`,
      attachments: [],
      streaming: false,
      createdAt: at(time),
      updatedAt: at(time),
    },
  };
}

const idle = { lastActivity: OLD, runStatus: "completed" } as const;
const THREADS = {
  person: threadEvents("person", { lineage: topLevel("person"), creationSource: "web", ...idle }),
  bot: threadEvents("mcp:bot", { lineage: topLevel("mcp:bot"), creationSource: "mcp", ...idle }),
  idleWorker: threadEvents("worker:idle", {
    lineage: childOf("mcp:bot", "subagent"),
    creationSource: "mcp",
    ...idle,
  }),
  idleWorkerChild: threadEvents("worker:idle:child", {
    lineage: childOf("worker:idle", "subagent"),
    creationSource: "mcp",
    ...idle,
  }),
  recentWorker: threadEvents("worker:recent", {
    lineage: childOf("person", "subagent"),
    creationSource: "provider",
    lastActivity: RECENT,
    runStatus: "completed",
  }),
  runningWorker: threadEvents("worker:running", {
    lineage: childOf("person", "subagent"),
    creationSource: "provider",
    lastActivity: OLD,
    runStatus: "running",
  }),
  workerWithRecentChild: threadEvents("worker:parent", {
    lineage: childOf("mcp:bot", "subagent"),
    creationSource: "mcp",
    ...idle,
  }),
  recentGrandchild: threadEvents("worker:grandchild", {
    lineage: childOf("worker:parent", "subagent"),
    creationSource: "mcp",
    lastActivity: RECENT,
    runStatus: "completed",
  }),
  forkedWorker: threadEvents("worker:forked", {
    lineage: childOf("person", "subagent"),
    creationSource: "provider",
    ...idle,
  }),
  personFork: threadEvents("person:fork", {
    lineage: childOf("worker:forked", "fork"),
    creationSource: "web",
    lastActivity: RECENT,
    runStatus: "completed",
  }),
};

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(NOW));
  const sink = yield* EventSink.EventSinkV2;
  yield* sink.write({ events: Object.values(THREADS).flat() });
});

const readThread = (id: string) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const { projection } = yield* store.getThreadSnapshot(ThreadId.make(id));
    return {
      thread: projection.thread,
      runs: projection.runs.length,
      messages: projection.messages.length,
    };
  });

it.effect("deletes only the transcript of an idle worker nothing still reads", () =>
  Effect.gen(function* () {
    yield* seed;
    const ids = Object.values(THREADS).map((events) => events[0]!.threadId);
    const before = yield* Effect.forEach(ids, readThread);

    const pruned = [ThreadId.make("worker:idle"), ThreadId.make("worker:idle:child")];
    const plan = yield* planWorkerThreadPrune();
    assert.deepStrictEqual(plan.threadIds, pruned);
    assert.strictEqual(plan.workerThreadCount, 7);
    // Idle themselves, but a newer child or a person's fork still reads them.
    assert.strictEqual(plan.keptThreadCount, 2);
    const result = yield* pruneWorkerThreads(plan).pipe(TestClock.withLive);
    assert.strictEqual(result.prunedThreadCount, 2);
    assert.strictEqual(result.rows.orchestration_v2_projection_messages, 2);

    const after = yield* Effect.forEach(ids, readThread);
    for (const [index, id] of ids.entries()) {
      const expected = pruned.includes(id) ? { ...before[index]!, messages: 0 } : before[index]!;
      assert.deepStrictEqual(after[index], expected, id);
    }
    assert.deepStrictEqual((yield* planWorkerThreadPrune()).threadIds, []);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps an idle worker that the server would resume after a restart", () =>
  Effect.gen(function* () {
    yield* seed;
    const threadId = ThreadId.make("worker:idle");
    const sink = yield* EventSink.EventSinkV2;
    // Recovery lists a thread whose command still runs.
    yield* sink.write({
      events: [
        {
          type: "turn-item.updated",
          id: EventId.make("event:worker:idle:command"),
          threadId,
          occurredAt: at(OLD),
          payload: {
            id: TurnItemId.make("item:worker:idle:command"),
            type: "command_execution",
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "running",
            title: null,
            input: "make test",
            startedAt: at(OLD),
            completedAt: null,
            updatedAt: at(OLD),
          },
        },
      ],
    });
    const before = yield* readThread("worker:idle");

    const plan = yield* planWorkerThreadPrune();
    assert.deepStrictEqual(plan.threadIds, [ThreadId.make("worker:idle:child")]);
    assert.strictEqual(plan.keptThreadCount, 3);
    yield* pruneWorkerThreads(plan).pipe(TestClock.withLive);
    assert.deepStrictEqual(yield* readThread("worker:idle"), before);
  }).pipe(Effect.provide(layer)),
);

const WAKE_UPS = {
  "it gets a new message": [message("worker:idle", 2, NOW)],
  "its planned child gets a new message": [message("worker:idle:child", 2, NOW)],
  "a fork of it is made after the plan": threadEvents("person:late-fork", {
    lineage: childOf("worker:idle", "fork"),
    creationSource: "web",
    lastActivity: NOW,
    runStatus: "completed",
    createdAt: NOW,
  }),
};

it.effect.each(Object.entries(WAKE_UPS))("keeps a planned worker when %s", ([, events]) =>
  Effect.gen(function* () {
    yield* seed;
    const plan = yield* planWorkerThreadPrune();
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({ events });
    const before = yield* readThread("worker:idle");

    const result = yield* pruneWorkerThreads(plan).pipe(TestClock.withLive);
    assert.isAtLeast(result.skippedThreadCount, 1);
    assert.deepStrictEqual(yield* readThread("worker:idle"), before);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["INCREMENTAL", true],
  ["NONE", false],
] as const)(
  "reports whether a running server returns freed pages (auto_vacuum %s)",
  ([mode, incrementalVacuum]) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`PRAGMA auto_vacuum = ${mode}`);
      yield* sql`VACUUM`;
      yield* seed;
      const result = yield* pruneWorkerThreads(yield* planWorkerThreadPrune()).pipe(
        TestClock.withLive,
      );
      assert.strictEqual(result.incrementalVacuum, incrementalVacuum);
    }).pipe(Effect.provide(layer)),
);
