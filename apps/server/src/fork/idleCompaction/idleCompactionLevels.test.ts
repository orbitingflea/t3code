import { describe, expect, it } from "@effect/vitest";
import {
  type CompactIdleChoice,
  compactIdleChoicePatch,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  idleCompactionOf,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ServerSettings as ServerSettingsSchema,
  ThreadId,
  WHILE_IDLE_COMPACTION_ID_PREFIX,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as IdleCompactionService from "../../orchestration-v2/IdleCompactionService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as LastUserInput from "./lastUserInput.ts";

const NOW_MS = Date.parse("2026-11-03T12:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);
const threadId = ThreadId.make("idle-thread");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread");
const modelSelection = { instanceId, model: "claude-haiku-5-5" };
const nodeId = NodeId.make("root-node");
const decodeServerSettings = Schema.decodeUnknownOption(ServerSettingsSchema);

type Projection = {
  -readonly [Key in keyof OrchestrationV2ThreadProjection]: OrchestrationV2ThreadProjection[Key];
};

/** Appends a completed run at `offset`, as its run.updated event reports it. */
function completeRun(
  data: Projection,
  text: string,
  usedTokens: number,
  offset: number,
  // A subscription's 1h prompt cache.
  cacheExpiresAtOffset: number | null = offset + 60 * MINUTE_MS,
  message: {
    readonly sentAt?: number;
    readonly creator?: Pick<Projection["messages"][number], "createdBy" | "creationSource">;
  } = {},
) {
  const ordinal = data.runs.length + 1;
  const runId = RunId.make(`run-${ordinal}`);
  const messageId = MessageId.make(`message-${ordinal}`);
  const sentAt = message.sentAt ?? offset;
  const run = {
    id: runId,
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId,
    userMessageId: messageId,
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "completed" as const,
    requestedAt: at(sentAt),
    startedAt: at(sentAt),
    completedAt: at(offset),
    checkpointId: null,
    contextHandoffId: null,
  };
  data.runs = [...data.runs, run];
  data.messages = [
    ...data.messages,
    {
      id: messageId,
      threadId,
      runId,
      nodeId,
      role: "user",
      text,
      attachments: [],
      streaming: false,
      createdBy: "user",
      creationSource: "web",
      ...message.creator,
      createdAt: at(sentAt),
      updatedAt: at(sentAt),
    },
  ];
  data.providerTurns = [
    ...data.providerTurns,
    {
      id: ProviderTurnId.make(`provider-turn-${ordinal}`),
      providerThreadId,
      nodeId,
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal,
      status: "completed",
      startedAt: at(sentAt),
      completedAt: at(offset),
      tokenUsage: {
        usedTokens,
        ...(cacheExpiresAtOffset === null
          ? {}
          : { promptCacheExpiresAt: DateTime.formatIso(at(cacheExpiresAtOffset)) }),
        updatedAt: DateTime.formatIso(at(offset)),
      },
    },
  ];
  return {
    id: EventId.make(`completed-${ordinal}`),
    type: "run.updated" as const,
    threadId,
    runId,
    occurredAt: at(offset),
    payload: run,
  };
}

/** The update an earlier completed run reports at `offset`, as a delegated task's end or a Stop does. */
function reportCompletedRunAgain(
  data: Projection,
  runId: RunId,
  offset: number,
  delegatedCompletion: NonNullable<Projection["runs"][number]["delegatedCompletion"]>,
) {
  const run = { ...data.runs.find((candidate) => candidate.id === runId)!, delegatedCompletion };
  data.runs = data.runs.map((candidate) => (candidate.id === runId ? run : candidate));
  return {
    id: EventId.make(`updated-${runId}-${offset}`),
    type: "run.updated" as const,
    threadId,
    runId,
    occurredAt: at(offset),
    payload: run,
  };
}

const FROM_SERVER = { createdBy: "agent", creationSource: "server" } as const;

type RunUpdate = ReturnType<typeof completeRun> | ReturnType<typeof reportCompletedRunAgain>;

const RESULT_ON_ITS_WAY = {
  disposition: "open",
  nextGeneration: 2,
  delivery: {
    generation: 1,
    messageId: MessageId.make("delegated-result"),
    taskIds: [NodeId.make("delegated-task")],
  },
} as const;

function setDelegatedTaskRunning(data: Projection, running: boolean) {
  data.providerThreads = data.providerThreads.map((thread) => ({
    ...thread,
    pendingBackgroundTasks: running ? [{ taskId: "delegated-task", kind: "subagent" }] : [],
  }));
}

function projection(): Projection {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Idle thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-MINUTE_MS),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [],
    messages: [],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: at(-MINUTE_MS),
        updatedAt: at(),
      },
    ],
    providerTurns: [],
    runtimeRequests: [],
    turnItems: [],
    contextTransfers: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    plans: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    visibleTurnItems: [],
    updatedAt: at(),
  };
}

/**
 * Runs the idle compaction service on one thread whose first turn ends at
 * NOW with `usedTokens`, then hands `script` the controls to move time and
 * the thread on. Its user message went out at `firstMessageAt`, NOW by default.
 */
const idleCompactions = (options: {
  readonly usedTokens: number;
  readonly cacheExpiresAtOffset?: number | null;
  readonly firstMessageAt?: number;
  readonly lastAnswerAt?: number;
  /** The global "Compact idle threads" choice, "whenIdle" by default. */
  readonly mode?: CompactIdleChoice;
  readonly instanceMode?: "default" | "beforeCacheExpires";
  readonly driver?: string;
  readonly values?: Partial<
    Pick<
      ServerSettingsSchema,
      "compactBeforeCacheExpiresTokens" | "compactWhenIdleTokens" | "compactWhenIdleMinutes"
    >
  >;
  readonly script: (controls: {
    readonly data: Projection;
    readonly emit: (event: RunUpdate) => Effect.Effect<void>;
    readonly compacted: ReadonlyArray<string>;
    readonly markers: ReadonlyArray<string | undefined>;
    readonly wireMarkers: ReadonlyArray<string | undefined>;
  }) => Effect.Effect<void>;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const data = projection();
      const events = yield* Queue.unbounded<RunUpdate>();
      const compacted: Array<string> = [];
      const markers: Array<string | undefined> = [];
      const wireMarkers: Array<string | undefined> = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromQueue(events),
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "message.dispatch") {
                compacted.push(
                  command.messageId.replace(WHILE_IDLE_COMPACTION_ID_PREFIX, "idle-compact:"),
                );
                markers.push(idleCompactionOf({ ...command, id: command.messageId, role: "user" }));
                wireMarkers.push(command.idleCompaction);
              }
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.succeed(data.thread),
          getThreadRecords: () => Effect.sync(() => data),
        }),
        Layer.mock(LastUserInput.LastUserInput)({
          atMs: () =>
            Effect.sync(() => {
              if (options.lastAnswerAt !== undefined) return NOW_MS + options.lastAnswerAt;
              const sent = data.messages.findLast(
                (message) => message.createdBy === "user" || message.creationSource === "mcp",
              )?.createdAt;
              return sent === undefined ? null : DateTime.toEpochMillis(sent);
            }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            ...compactIdleChoicePatch(options.mode ?? "whenIdle"),
            ...options.values,
            providerInstances: {
              [instanceId]: {
                driver: ProviderDriverKind.make(options.driver ?? "claudeAgent"),
                config: { idleCompaction: options.instanceMode ?? "default" },
              },
            },
          }),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* IdleCompactionService.make;
        yield* service.start();
        yield* Queue.offer(
          events,
          completeRun(
            data,
            "Explain this code",
            options.usedTokens,
            0,
            options.cacheExpiresAtOffset,
            options.firstMessageAt === undefined ? {} : { sentAt: options.firstMessageAt },
          ),
        );
        yield* options.script({
          data,
          emit: (event) => Queue.offer(events, event).pipe(Effect.asVoid),
          compacted,
          markers,
          wireMarkers,
        });
      }).pipe(Effect.provide(dependencies));
    }),
  );

const idleCompact = (run: string) => `idle-compact:${threadId}:${run}`;
const advanceTo = (offsetMs: number) => TestClock.setTime(NOW_MS + offsetMs);

describe("idle compaction levels", () => {
  it.effect("compacts a thread at 400K or more 15 minutes after the last user message", () =>
    idleCompactions({
      usedTokens: 400_000,
      script: ({ compacted, markers, wireMarkers }) =>
        Effect.gen(function* () {
          yield* advanceTo(15 * MINUTE_MS - 1);
          expect(compacted).toEqual([]);
          yield* advanceTo(15 * MINUTE_MS);
          expect(compacted).toEqual([idleCompact("run-1")]);
          expect(markers).toEqual(["whileIdle"]);
          expect(wireMarkers).toEqual(["beforeCacheExpires"]);
        }),
    }),
  );

  it.effect(
    "counts from an answer, so a run that an answer resumed does not compact at its end",
    () =>
      idleCompactions({
        usedTokens: 450_000,
        firstMessageAt: -20 * MINUTE_MS,
        lastAnswerAt: -MINUTE_MS,
        script: ({ compacted }) =>
          Effect.gen(function* () {
            yield* advanceTo(14 * MINUTE_MS - 1);
            expect(compacted).toEqual([]);
            yield* advanceTo(14 * MINUTE_MS);
            expect(compacted).toEqual([idleCompact("run-1")]);
            yield* advanceTo(60 * MINUTE_MS);
            expect(compacted).toEqual([idleCompact("run-1")]);
          }),
      }),
  );

  it.effect("counts from the message, not from the end of the run", () =>
    idleCompactions({
      usedTokens: 450_000,
      firstMessageAt: -10 * MINUTE_MS,
      script: ({ compacted }) =>
        Effect.gen(function* () {
          yield* advanceTo(5 * MINUTE_MS - 1);
          expect(compacted).toEqual([]);
          yield* advanceTo(5 * MINUTE_MS);
          expect(compacted).toEqual([idleCompact("run-1")]);
        }),
    }),
  );

  it.effect("compacts once, as soon as a run that outlasted the wait ends", () =>
    idleCompactions({
      usedTokens: 450_000,
      firstMessageAt: -20 * MINUTE_MS,
      script: ({ compacted, markers }) =>
        Effect.gen(function* () {
          yield* advanceTo(1);
          expect(compacted).toEqual([idleCompact("run-1")]);
          expect(markers).toEqual(["whileIdle"]);
          yield* advanceTo(60 * MINUTE_MS);
          expect(compacted).toEqual([idleCompact("run-1")]);
        }),
    }),
  );

  it.effect("names the cache level when it comes first on a thread over both lines", () =>
    idleCompactions({
      usedTokens: 450_000,
      // An API key's 5m prompt cache.
      cacheExpiresAtOffset: 5 * MINUTE_MS,
      script: ({ compacted, markers }) =>
        Effect.gen(function* () {
          yield* advanceTo(3 * MINUTE_MS - 1);
          expect(compacted).toEqual([]);
          yield* advanceTo(3 * MINUTE_MS);
          expect(compacted).toEqual([idleCompact("run-1")]);
          expect(markers).toEqual(["beforeCacheExpires"]);
        }),
    }),
  );

  it.effect("leaves a thread under 400K for the cache-expiry level", () =>
    idleCompactions({
      usedTokens: 399_999,
      script: ({ compacted, markers }) =>
        Effect.gen(function* () {
          yield* advanceTo(30 * MINUTE_MS);
          expect(compacted).toEqual([]);
          yield* advanceTo(58 * MINUTE_MS);
          expect(compacted).toEqual([idleCompact("run-1")]);
          expect(markers).toEqual(["beforeCacheExpires"]);
        }),
    }),
  );

  it.effect("drops the wait when a new turn starts before it ends", () =>
    idleCompactions({
      usedTokens: 450_000,
      script: ({ data, compacted }) =>
        Effect.gen(function* () {
          yield* advanceTo(3 * MINUTE_MS);
          completeRun(data, "Keep going", 460_000, 4 * MINUTE_MS);
          data.runs = data.runs.map((run) =>
            run.ordinal === 2 ? { ...run, status: "running", completedAt: null } : run,
          );
          yield* advanceTo(60 * MINUTE_MS);
          expect(compacted).toEqual([]);
        }),
    }),
  );

  it.effect("starts the wait again from a new user message that arrives before it ends", () =>
    idleCompactions({
      usedTokens: 450_000,
      script: ({ data, emit, compacted }) =>
        Effect.gen(function* () {
          yield* advanceTo(11 * MINUTE_MS);
          yield* emit(
            completeRun(data, "Keep going", 460_000, 11 * MINUTE_MS, undefined, {
              sentAt: 10 * MINUTE_MS,
            }),
          );
          yield* advanceTo(25 * MINUTE_MS - 1);
          expect(compacted).toEqual([]);
          yield* advanceTo(25 * MINUTE_MS);
          expect(compacted).toEqual([idleCompact("run-2")]);
        }),
    }),
  );

  it.effect("compacts once, even when the compacted context is still over the line", () =>
    idleCompactions({
      usedTokens: 450_000,
      values: { compactWhenIdleTokens: "10000" },
      script: ({ data, emit, compacted }) =>
        Effect.gen(function* () {
          yield* advanceTo(15 * MINUTE_MS);
          expect(compacted).toEqual([idleCompact("run-1")]);
          yield* emit(
            completeRun(data, "/compact", 20_000, 16 * MINUTE_MS, undefined, {
              creator: FROM_SERVER,
            }),
          );
          yield* advanceTo(120 * MINUTE_MS);
          expect(compacted).toEqual([idleCompact("run-1")]);
        }),
    }),
  );

  it.effect("reads the wait and its token line from the saved values", () =>
    idleCompactions({
      usedTokens: 150_000,
      values: { compactWhenIdleMinutes: "1", compactWhenIdleTokens: "100000" },
      script: ({ compacted }) =>
        Effect.gen(function* () {
          yield* advanceTo(MINUTE_MS - 1);
          expect(compacted).toEqual([]);
          yield* advanceTo(MINUTE_MS);
          expect(compacted).toEqual([idleCompact("run-1")]);
        }),
    }),
  );

  it.effect.each(["0", "400k", "", "10000"])(
    "keeps the default wait and the other values when the minutes value is '%s'",
    (value) =>
      idleCompactions({
        usedTokens: 150_000,
        values: { compactWhenIdleMinutes: value, compactWhenIdleTokens: "100000" },
        script: ({ compacted }) =>
          Effect.gen(function* () {
            yield* advanceTo(15 * MINUTE_MS - 1);
            expect(compacted).toEqual([]);
            yield* advanceTo(15 * MINUTE_MS);
            expect(compacted).toEqual([idleCompact("run-1")]);
          }),
      }),
  );

  it.effect.each(
    ["0", "400k", "", "10000000"].flatMap((value) => [
      { value, usedTokens: 400_000, compacts: true },
      { value, usedTokens: 399_999, compacts: false },
    ]),
  )(
    "keeps the default idle line and the other values at $usedTokens when the value is '$value'",
    ({ value, usedTokens, compacts }) =>
      idleCompactions({
        usedTokens,
        values: { compactWhenIdleTokens: value, compactWhenIdleMinutes: "1" },
        script: ({ compacted }) =>
          Effect.gen(function* () {
            yield* advanceTo(MINUTE_MS);
            expect(compacted).toEqual(compacts ? [idleCompact("run-1")] : []);
          }),
      }),
  );

  it.effect.each([
    { expiry: "unknown", cacheExpiresAtOffset: null },
    { expiry: "already past", cacheExpiresAtOffset: -MINUTE_MS },
  ])("compacts after the wait when the cache expiry is $expiry", ({ cacheExpiresAtOffset }) =>
    idleCompactions({
      usedTokens: 450_000,
      cacheExpiresAtOffset,
      script: ({ compacted }) =>
        Effect.gen(function* () {
          yield* advanceTo(15 * MINUTE_MS - 1);
          expect(compacted).toEqual([]);
          yield* advanceTo(15 * MINUTE_MS);
          expect(compacted).toEqual([idleCompact("run-1")]);
        }),
    }),
  );

  it.effect.each(
    (["beforeCacheExpires", "whenIdle"] as const).flatMap((mode) => [
      { mode, usedTokens: 200_000, values: {}, compacts: true },
      { mode, usedTokens: 199_999, values: {}, compacts: false },
      {
        mode,
        usedTokens: 250_000,
        values: { compactBeforeCacheExpiresTokens: "300000" },
        compacts: false,
      },
      {
        mode,
        usedTokens: 150_000,
        values: { compactBeforeCacheExpiresTokens: "100000" },
        compacts: true,
      },
      ...["0", "400k", "", "10000000"].flatMap((value) => [
        {
          mode,
          usedTokens: 199_999,
          values: { compactBeforeCacheExpiresTokens: value },
          compacts: false,
        },
        {
          mode,
          usedTokens: 450_000,
          values: { compactBeforeCacheExpiresTokens: value, compactWhenIdleTokens: "500000" },
          compacts: true,
        },
      ]),
    ]),
  )(
    "applies the cache-expiry level's token line in $mode: $usedTokens with $values",
    ({ mode, usedTokens, values, compacts }) =>
      idleCompactions({
        usedTokens,
        mode,
        values,
        script: ({ compacted }) =>
          Effect.gen(function* () {
            yield* advanceTo(58 * MINUTE_MS - 1);
            expect(compacted).toEqual([]);
            yield* advanceTo(58 * MINUTE_MS);
            expect(compacted).toEqual(compacts ? [idleCompact("run-1")] : []);
          }),
      }),
  );

  it.effect.each([
    { when: "plain Before the cache expires", mode: "beforeCacheExpires", instanceMode: "default" },
    { when: "a provider override", mode: "whenIdle", instanceMode: "beforeCacheExpires" },
  ] as const)(
    "compacts only before the cache expires, at the saved token line, for $when",
    ({ mode, instanceMode }) =>
      idleCompactions({
        usedTokens: 150_000,
        mode,
        instanceMode,
        values: {
          compactBeforeCacheExpiresTokens: "100000",
          compactWhenIdleTokens: "100000",
          compactWhenIdleMinutes: "1",
        },
        script: ({ compacted, markers }) =>
          Effect.gen(function* () {
            yield* advanceTo(58 * MINUTE_MS - 1);
            expect(compacted).toEqual([]);
            yield* advanceTo(58 * MINUTE_MS);
            expect(compacted).toEqual([idleCompact("run-1")]);
            expect(markers).toEqual(["beforeCacheExpires"]);
          }),
      }),
  );

  it.effect("leaves a thread on another provider alone", () =>
    idleCompactions({
      usedTokens: 450_000,
      driver: "codex",
      script: ({ compacted }) =>
        Effect.gen(function* () {
          yield* advanceTo(120 * MINUTE_MS);
          expect(compacted).toEqual([]);
        }),
    }),
  );

  it.effect("compacts once the result is delivered when a delegated task ends after the wait", () =>
    idleCompactions({
      usedTokens: 450_000,
      script: ({ data, emit, compacted, markers }) =>
        Effect.gen(function* () {
          setDelegatedTaskRunning(data, true);
          yield* advanceTo(120 * MINUTE_MS);
          expect(compacted).toEqual([]);

          setDelegatedTaskRunning(data, false);
          yield* emit(
            reportCompletedRunAgain(data, RunId.make("run-1"), 120 * MINUTE_MS, RESULT_ON_ITS_WAY),
          );
          yield* advanceTo(125 * MINUTE_MS);
          expect(compacted).toEqual([]);

          yield* emit(
            completeRun(data, "Delegated task finished", 460_000, 126 * MINUTE_MS, undefined, {
              creator: FROM_SERVER,
            }),
          );
          yield* advanceTo(126 * MINUTE_MS + 1);
          expect(compacted).toEqual([idleCompact("run-2")]);
          expect(markers).toEqual(["whileIdle"]);
        }),
    }),
  );

  it.effect("does not move the start time for a result delivered before the wait ends", () =>
    idleCompactions({
      usedTokens: 450_000,
      script: ({ data, emit, compacted }) =>
        Effect.gen(function* () {
          yield* advanceTo(5 * MINUTE_MS);
          yield* emit(
            completeRun(data, "Delegated task finished", 460_000, 6 * MINUTE_MS, undefined, {
              creator: FROM_SERVER,
            }),
          );
          yield* advanceTo(15 * MINUTE_MS - 1);
          expect(compacted).toEqual([]);
          yield* advanceTo(15 * MINUTE_MS);
          expect(compacted).toEqual([idleCompact("run-2")]);
        }),
    }),
  );

  it.effect("waits for the delivered result when an earlier run's task ends after the wait", () =>
    idleCompactions({
      usedTokens: 450_000,
      script: ({ data, emit, compacted }) =>
        Effect.gen(function* () {
          setDelegatedTaskRunning(data, true);
          yield* emit(completeRun(data, "Keep going", 460_000, MINUTE_MS));
          yield* advanceTo(120 * MINUTE_MS);

          setDelegatedTaskRunning(data, false);
          yield* emit(
            reportCompletedRunAgain(data, RunId.make("run-1"), 120 * MINUTE_MS, RESULT_ON_ITS_WAY),
          );
          yield* advanceTo(125 * MINUTE_MS);
          expect(compacted).toEqual([]);
        }),
    }),
  );

  it.effect("waits for the delivered result inside the cache level's window", () =>
    idleCompactions({
      usedTokens: 250_000,
      script: ({ data, emit, compacted }) =>
        Effect.gen(function* () {
          setDelegatedTaskRunning(data, true);
          yield* advanceTo(59 * MINUTE_MS);

          setDelegatedTaskRunning(data, false);
          yield* emit(
            reportCompletedRunAgain(data, RunId.make("run-1"), 59 * MINUTE_MS, RESULT_ON_ITS_WAY),
          );
          yield* advanceTo(59 * MINUTE_MS + 1);
          expect(compacted).toEqual([]);
        }),
    }),
  );

  it.effect.each([
    { when: "after the wait", stopAt: 120 * MINUTE_MS, compactsAt: 120 * MINUTE_MS + 1 },
    { when: "before the wait ends", stopAt: 10 * MINUTE_MS, compactsAt: 15 * MINUTE_MS },
  ])("keeps the start time when a Stop updates the completed run $when", ({ stopAt, compactsAt }) =>
    idleCompactions({
      usedTokens: 450_000,
      script: ({ data, emit, compacted }) =>
        Effect.gen(function* () {
          setDelegatedTaskRunning(data, true);
          yield* advanceTo(stopAt);

          setDelegatedTaskRunning(data, false);
          yield* emit(
            reportCompletedRunAgain(data, RunId.make("run-1"), stopAt, {
              disposition: "stopped",
              nextGeneration: 1,
              delivery: null,
            }),
          );
          yield* advanceTo(compactsAt - 1);
          if (compactsAt > stopAt + 1) expect(compacted).toEqual([]);
          yield* advanceTo(compactsAt);
          expect(compacted).toEqual([idleCompact("run-1")]);
        }),
    }),
  );

  it.each(["0", "400k", "", "600,000"])(
    "decodes saved values of '%s', so the rest of the settings survive",
    (value) => {
      const decoded = decodeServerSettings({
        compactWhenIdle: true,
        compactBeforeCacheExpiresTokens: value,
        compactWhenIdleTokens: value,
        compactWhenIdleMinutes: value,
      });
      expect(Option.getOrUndefined(decoded)?.compactWhenIdle).toBe(true);
    },
  );

  it.effect.each(["onReturn", "off"] as const)(
    "does not compact after the wait when idle compaction is $0",
    (mode) =>
      idleCompactions({
        usedTokens: 450_000,
        mode,
        script: ({ compacted }) =>
          Effect.gen(function* () {
            yield* advanceTo(60 * MINUTE_MS);
            expect(compacted).toEqual([]);
          }),
      }),
  );
});

it.layer(LastUserInput.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "the last user input",
  (it) => {
    const thread = ThreadId.make("clock-thread");
    const insertMessage = (
      id: string,
      minutes: number,
      fields: Record<string, unknown>,
      role = "user",
    ) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const createdAt = DateTime.formatIso(at(minutes * MINUTE_MS));
        const payload = JSON.stringify({ text: id, attachments: [], ...fields });
        yield* sql`
          INSERT INTO orchestration_v2_projection_messages (
            message_id, thread_id, role, streaming, created_at, updated_at, payload_json
          ) VALUES (${id}, ${thread}, ${role}, 0, ${createdAt}, ${createdAt}, ${payload})
        `;
      });
    const insertRequest = (id: string, minutes: number, status: string) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const resolvedAt = DateTime.formatIso(at(minutes * MINUTE_MS));
        yield* sql`
          INSERT INTO orchestration_v2_projection_runtime_requests (
            runtime_request_id, thread_id, node_id, kind, status, created_at, resolved_at,
            payload_json
          ) VALUES (
            ${id}, ${thread}, ${nodeId}, 'approval', ${status}, ${resolvedAt}, ${resolvedAt}, '{}'
          )
        `;
      });
    const lastUserInputMinutes = Effect.gen(function* () {
      const lastMs = yield* (yield* LastUserInput.LastUserInput).atMs(thread);
      return lastMs === null ? null : (lastMs - NOW_MS) / MINUTE_MS;
    });

    it.effect("reads a person's or a bot's message and skips what the server sends", () =>
      Effect.gen(function* () {
        expect(yield* lastUserInputMinutes).toBeNull();

        yield* insertMessage("first-from-server", -1, FROM_SERVER);
        expect(yield* lastUserInputMinutes).toBeNull();

        for (const [id, minutes, creator] of [
          ["web", 1, { createdBy: "user", creationSource: "web" }],
          ["mobile", 2, { createdBy: "user", creationSource: "mobile" }],
          ["bot", 3, { createdBy: "agent", creationSource: "mcp" }],
          ["answer", 4, { createdBy: "user", creationSource: "server" }],
        ] as const) {
          yield* insertMessage(id, minutes, creator);
          expect(yield* lastUserInputMinutes).toBe(minutes);
        }

        yield* insertMessage("idle-compact", 5, {
          ...FROM_SERVER,
          idleCompaction: "beforeCacheExpires",
        });
        yield* insertMessage("delegated-result", 6, {
          ...FROM_SERVER,
          delegatedCompletion: { parentRunId: "run", generation: 1, taskIds: [] },
        });
        yield* insertMessage("background-wake", 7, {
          createdBy: "agent",
          creationSource: "provider",
          notification: { source: { kind: "background_task" }, outcome: "updated", summary: "x" },
        });
        yield* insertMessage(
          "assistant",
          8,
          { createdBy: "agent", creationSource: "provider" },
          "assistant",
        );
        expect(yield* lastUserInputMinutes).toBe(4);
      }),
    );

    it.effect("reads an answered request and skips one no one answered", () =>
      Effect.gen(function* () {
        yield* insertMessage("baseline", 4, { createdBy: "user", creationSource: "web" });
        yield* insertRequest("older-answer", 3, "resolved");
        expect(yield* lastUserInputMinutes).toBe(4);

        for (const status of ["pending", "expired", "cancelled"]) {
          yield* insertRequest(`later-${status}`, 20, status);
        }
        expect(yield* lastUserInputMinutes).toBe(4);

        yield* insertRequest("answer", 9, "resolved");
        expect(yield* lastUserInputMinutes).toBe(9);
      }),
    );
  },
);
