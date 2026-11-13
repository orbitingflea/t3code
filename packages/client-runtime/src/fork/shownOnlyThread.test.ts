import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import * as ThreadHistoryController from "../state/threadHistoryController.ts";
import { makeEnvironmentThreadState } from "../state/threads.ts";
import * as ThreadSnapshotLoader from "../state/threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = v2ThreadId;
const SAVED: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, title: "Saved Normal view" },
};
const SHOWN: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, title: "Shown view" },
};

// The view is the last argument of makeEnvironmentThreadState, which the base call does not take.
type MakeThreadState = (
  threadId: ThreadId,
  resumeCache?: undefined,
  shownOnly?: boolean,
) => ReturnType<typeof makeEnvironmentThreadState>;

const makeHarness = Effect.fn("TestShownOnlyThread.makeHarness")(function* (shownOnly: boolean) {
  const subscriptions = yield* Queue.unbounded<{
    readonly input: OrchestrationV2SubscribeThreadInput;
    readonly events: Queue.Queue<OrchestrationV2ThreadStreamItem>;
  }>();
  const olderLoads = yield* Queue.unbounded<{
    readonly url: URL;
    readonly response: Deferred.Deferred<OrchestrationV2ThreadHistoryPage>;
  }>();
  const cache = { loads: 0, saves: 0 };
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: OrchestrationV2SubscribeThreadInput) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
          yield* Queue.offer(subscriptions, { input, events });
          return Stream.fromQueue(events);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({ threadSnapshotPagination: true } as never),
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        socketUrl: TARGET.wsBaseUrl,
        httpAuthorization: null,
        target: TARGET,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const store = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () =>
      Effect.sync(() => {
        cache.loads += 1;
        return Option.some({ snapshotSequence: 7, projection: SAVED });
      }),
    saveThread: () =>
      Effect.sync(() => {
        cache.saves += 1;
      }),
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const historyController = yield* Effect.service(
    ThreadHistoryController.ThreadHistoryController,
  ).pipe(Effect.provide(ThreadHistoryController.layer));
  const snapshotLoader = ThreadSnapshotLoader.ThreadSnapshotLoader.of({
    load: () => Effect.die("Unexpected HTTP snapshot"),
  });
  const make: MakeThreadState = makeEnvironmentThreadState;
  const scope = yield* Scope.make();
  const threadState = yield* make(THREAD_ID, undefined, shownOnly).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, store),
    Effect.provideService(ThreadSnapshotLoader.ThreadSnapshotLoader, snapshotLoader),
    Effect.provideService(ThreadHistoryController.ThreadHistoryController, historyController),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request, url) =>
        Effect.gen(function* () {
          const response = yield* Deferred.make<OrchestrationV2ThreadHistoryPage>();
          yield* Queue.offer(olderLoads, { url, response });
          return HttpClientResponse.fromWeb(
            request,
            Response.json(yield* Deferred.await(response)),
          );
        }),
      ),
    ),
    Scope.provide(scope),
  );
  const subscription = yield* Queue.take(subscriptions);
  yield* Queue.offer(subscription.events, {
    kind: "snapshot",
    snapshotSequence: 12,
    projection: SHOWN,
    historyCursor: "older-1",
    hasMoreHistory: true,
    latestLocalTurnOrdinal: 4,
  });
  yield* Queue.offer(subscription.events, { kind: "synchronized" });
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.filter((state) => state.status === "live"),
    Stream.runHead,
  );
  return {
    input: subscription.input,
    cache,
    olderLoads,
    threadState,
    close: Scope.close(scope, Exit.void),
    loadEarlier: (throughEntryId?: string) =>
      historyController.loadEarlier(TARGET.environmentId, THREAD_ID, throughEntryId),
  };
});

const sendRow = (key: string) => {
  const item = {
    id: TurnItemId.make(`older-send-${key}`),
    type: "dynamic_tool" as const,
    threadId: THREAD_ID,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed" as const,
    title: null,
    toolName: "mcp__t3-code__send_to_user",
    input: { text: `Older ${key}.` },
    startedAt: SHOWN.thread.createdAt,
    completedAt: SHOWN.thread.createdAt,
    updatedAt: SHOWN.thread.createdAt,
  };
  return {
    position: 0,
    visibility: "local" as const,
    sourceThreadId: THREAD_ID,
    sourceItemId: item.id,
    item,
  };
};

/** One request's result, or "another request" when the load asks the server again. */
const answerOnce = (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  load: Fiber.Fiber<unknown>,
  key: string,
) =>
  Effect.gen(function* () {
    const request = yield* Queue.take(harness.olderLoads);
    // A page with no message the user typed and more history after it, which Normal pages past.
    yield* Deferred.succeed(request.response, {
      snapshotSequence: 12,
      items: [sendRow(key)],
      nextCursor: `older-after-${key}`,
      hasMoreHistory: true,
    });
    const outcome = yield* Effect.raceFirst(
      Fiber.join(load).pipe(Effect.as("loaded" as const)),
      Queue.take(harness.olderLoads).pipe(Effect.as("another request" as const)),
    );
    return { url: request.url, outcome };
  });

describe("shown-only thread state", () => {
  it.effect.each([
    ["Normal", false, { loads: 1, saves: 1, title: "Shown view" }],
    ["shown-only", true, { loads: 0, saves: 0, title: "Shown view" }],
  ] as const)("a %s state and the saved thread snapshot", ([, shownOnly, expected]) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(shownOnly);
      expect(harness.input.shownOnly).toBe(shownOnly ? true : undefined);
      expect(harness.input.afterSequence).toBe(shownOnly ? undefined : 7);

      yield* TestClock.adjust("500 millis");
      yield* harness.close;
      const state = yield* SubscriptionRef.get(harness.threadState);
      expect({
        ...harness.cache,
        title: Option.getOrThrow(state.data).thread.title,
      }).toEqual(expected);
    }),
  );

  it.effect("a shown-only state loads one page per request, a targeted one too", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(true);

      const plain = yield* answerOnce(
        harness,
        yield* harness.loadEarlier().pipe(Effect.forkScoped),
        "1",
      );
      expect(plain.outcome).toBe("loaded");
      expect(plain.url.searchParams.get("cursor")).toBe("older-1");

      const targeted = yield* answerOnce(
        harness,
        yield* harness.loadEarlier("send-far-back").pipe(Effect.forkScoped),
        "2",
      );
      expect(targeted.outcome).toBe("loaded");
      expect(targeted.url.searchParams.get("view")).toBeNull();
      expect(targeted.url.searchParams.get("throughEntryId")).toBe("send-far-back");
      expect((yield* SubscriptionRef.get(harness.threadState)).history.historyCursor).toBe(
        "older-after-2",
      );
      yield* harness.close;
    }),
  );
});
