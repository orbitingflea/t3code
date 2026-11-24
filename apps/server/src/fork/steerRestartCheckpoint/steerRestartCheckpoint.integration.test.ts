import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const runSelection = {
  instanceId,
  model: "test-model",
  options: [{ id: "effort", value: "xhigh" }],
};
const composerSelection = {
  ...runSelection,
  options: [...runSelection.options, { id: "fastMode", value: false }],
};

// A provider that steers by interrupt-restart; the steer waits in planSelectionTransition.
const steerRestartHarness = Effect.fn("steerRestartHarness")(function* (
  name: string,
  beforeSelectionTransition: Effect.Effect<void>,
) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: false,
      supportsSteeringByInterruptRestart: true,
    },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () =>
      beforeSelectionTransition.pipe(Effect.as({ type: "apply_on_next_turn" as const })),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const turnUpdated = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          status: "running" | "interrupted",
        ) =>
          Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
              providerThreadId: turn.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: turn.attemptId,
              nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
              ordinal: turn.providerTurnOrdinal,
              status,
              startedAt: now,
              completedAt: status === "running" ? null : now,
            },
          });
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            started.push(turn);
            yield* turnUpdated(turn, "running");
          });
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: runSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn,
          compactThread: startTurn,
          steerTurn: () => Effect.die("unused"),
          interruptTurn: ({ providerTurnId }) =>
            Effect.forEach(
              started.filter(
                (turn) => ProviderTurnId.make(`provider-turn:${turn.attemptId}`) === providerTurnId,
              ),
              (turn) =>
                turnUpdated(turn, "interrupted").pipe(
                  Effect.andThen(
                    Queue.offer(events, {
                      type: "turn.terminal",
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId,
                      runOrdinal: turn.runOrdinal,
                      status: "interrupted",
                      failure: null,
                      threadDisposition: "reusable",
                    }),
                  ),
                ),
              { discard: true },
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  );
  const startFirstTurn = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Steer restart at turn end",
      modelSelection: runSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    yield* (yield* ThreadCommandExecutor.ThreadCommandExecutor).withLock(threadId, Effect.void);
    return threadId;
  });
  return { cwd, events, started, layer, startFirstTurn };
});

it.effect.each(["completed", "interrupted", "stopped before it starts"] as const)(
  "checkpoints a run whose turn ended while a steer restarted it (restart %s)",
  (restartEnd) =>
    Effect.gen(function* () {
      const steerReadRunning = yield* Deferred.make<void>();
      const letSteerCommit = yield* Deferred.make<void>();
      const { cwd, events, started, layer, startFirstTurn } = yield* steerRestartHarness(
        `steer-restart-after-turn-end-${restartEnd}`,
        Deferred.succeed(steerReadRunning, undefined).pipe(
          Effect.andThen(Deferred.await(letSteerCommit)),
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const runId = started[0]!.runId;
        const endTurn = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          status: "completed" | "interrupted",
        ) =>
          Effect.gen(function* () {
            const providerTurn = (yield* orchestrator.getThreadProjection(
              threadId,
            )).providerTurns.find((candidate) => candidate.runAttemptId === turn.attemptId)!;
            const settled = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === runId &&
                  event.payload.status === status,
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...providerTurn, status, completedAt: yield* DateTime.now },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: providerTurn.providerThreadId,
              providerTurnId: providerTurn.id,
              runOrdinal: turn.runOrdinal,
              status,
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(settled);
          });
        const writeWorkspaceFile = (name: string) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            yield* fileSystem.writeFileString(`${cwd}/${name}`, `${name}\n`);
          }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
        // The first turn's capture finds the run restarting and retries with backoff.
        const drainWithRetries = Effect.forEach(
          [1, 2, 3, 4, 5],
          () => TestClock.adjust("1 second").pipe(Effect.andThen(worker.drain())),
          { discard: true },
        );
        const checkpointFiles = Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          const checkpoint = projection.checkpoints.find(
            (candidate) => candidate.id === run?.checkpointId,
          );
          assert.equal(checkpoint?.status, "ready");
          return { status: run?.status, files: checkpoint?.files.map((file) => file.path) };
        });

        // The steer reads the run as running, then the turn ends before it commits its restart.
        const steer = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("steer-at-turn-end"),
            threadId,
            messageId: MessageId.make("message:steer-at-turn-end"),
            text: "also check the logs",
            attachments: [],
            modelSelection: composerSelection,
            dispatchMode: { type: "steer_active", targetRunId: runId },
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(steerReadRunning);
        yield* writeWorkspaceFile("first-attempt.txt");
        yield* endTurn(started[0]!, "completed");
        yield* Deferred.succeed(letSteerCommit, undefined);
        yield* Fiber.join(steer);

        if (restartEnd === "stopped before it starts") {
          yield* worker.runOnce();
          yield* orchestrator.dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop-before-restart-starts"),
            threadId,
          });
          yield* drainWithRetries;
          assert.equal(started.length, 1);
          const { status, files } = yield* checkpointFiles;
          assert.equal(status, "interrupted");
          assert.include(files ?? [], "first-attempt.txt");
          return;
        }

        const restartRunning = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.status === "running" &&
              event.payload.runAttemptId !== started[0]!.attemptId,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* drainWithRetries;
        yield* Fiber.join(restartRunning);
        yield* (yield* ThreadCommandExecutor.ThreadCommandExecutor).withLock(threadId, Effect.void);
        assert.equal(started.length, 2);
        assert.equal(started[1]!.runId, runId);

        yield* writeWorkspaceFile("restarted-attempt.txt");
        yield* endTurn(started[1]!, restartEnd);
        yield* worker.drain();
        const { status, files } = yield* checkpointFiles;
        assert.equal(status, restartEnd);
        assert.includeMembers(files ?? [], ["first-attempt.txt", "restarted-attempt.txt"]);
      }).pipe(Effect.provide(layer));
    }),
);
