import * as NodeSqlite from "node:sqlite";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  makeAntigravityAcpAdapterFlavor,
  makeAntigravityAdapterV2,
} from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { antigravitySessionMeta } from "../../provider/acp/AntigravityAcpSupport.ts";
import { makeAntigravityUsageProbe } from "../../provider/antigravityUsageLimits.ts";
import {
  type AntigravityTextGenerationOptions,
  makeAntigravityTextGeneration,
} from "../../textGeneration/AntigravityTextGeneration.ts";

type RuntimeInput = Parameters<
  Parameters<typeof makeAntigravityAcpAdapterFlavor>[0]["makeRuntime"]
>[0];

const baseOptions = {
  instanceId: ProviderInstanceId.make("antigravity-cli-test"),
  profileDirectory: "antigravity-profile-unused",
  digest: undefined as never,
  random: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  host: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not spawned in this test"),
  withProcess: (_stop, task) => task,
  defaultModel: Effect.undefined,
} satisfies Parameters<typeof makeAntigravityAcpAdapterFlavor>[0];

// Where `agy acp` keeps its sessions and login: under the user's home, whatever GEMINI_HOME says.
const cliRuntimeState = (path: Path.Path, userHome: string) =>
  Effect.succeed({
    runtime: "cli" as const,
    root: path.join(userHome, ".gemini"),
    appFolder: "antigravity-cli",
    tokenFile: "antigravity-oauth-token",
  });

const managedRuntimeState = (profileDirectory: string) =>
  Effect.succeed({
    runtime: "managed" as const,
    root: profileDirectory,
    appFolder: "antigravity-acp",
    tokenFile: "acp_token.json",
  });

const ERROR_MESSAGE = 17;
// An error step trimmed from `agy acp` 1.5.5: length-prefixed fields, so a length byte leads the status.
const CLI_API_ERROR = Buffer.concat([
  Buffer.from([0x1a, 0xde, 0x07, 0x0a, 0x28]),
  Buffer.from("Agent execution terminated due to error."),
  Buffer.from([0x12, 0x4f]),
  Buffer.from("FAILED_PRECONDITION (code 400): User location is not supported for the API use."),
  Buffer.from([0x1a, 0x2c]),
  Buffer.from('HTTP 400 Bad Request\n{\n  "error": {\n    "code": 400\n  }\n}'),
]);

const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const layerSession = Layer.mergeAll(
  layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(layer)),
);

type TextRuntime = Effect.Success<ReturnType<AntigravityTextGenerationOptions["makeRuntime"]>>;

const HELPER_SESSION = "047c62f6-607b-44db-bfbe-f83b67e9e8b1";

/** Runs one title helper on the CLI runtime and reports whether its fake agent started. */
const cliHelperTurn = Effect.fn("cliHelperTurn")(function* (
  userHome: string,
  reportedSession: string,
) {
  const path = yield* Path.Path;
  let sessionUpdate: Parameters<TextRuntime["handleSessionUpdate"]>[0] = () => Effect.void;
  let started = false;
  const handled = () => Effect.void;
  const options = {
    profileDirectory: path.join(userHome, "profile-unused"),
    runtimeState: cliRuntimeState(path, userHome),
    withProcess: ((_stop, task) => task) as AntigravityTextGenerationOptions["withProcess"],
    makeRuntime: () =>
      Effect.succeed({
        start: () =>
          Effect.sync(() => {
            started = true;
            return {
              sessionId: reportedSession,
              initializeResult: { protocolVersion: 1 },
              sessionSetupResult: { sessionId: reportedSession },
              modelConfigId: "model",
            };
          }),
        setMode: () => Effect.succeed({}),
        getConfigOptions: Effect.succeed([]),
        getEvents: () => Stream.empty,
        setModel: handled,
        setConfigOption: () => Effect.succeed({ configOptions: [] }),
        prompt: () =>
          sessionUpdate({
            sessionId: reportedSession,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: '{"title":"Repair login"}' },
            },
          }).pipe(Effect.as({ stopReason: "end_turn" as const })),
        cancel: Effect.void,
        handleSessionUpdate: (handler) =>
          Effect.sync(() => {
            sessionUpdate = handler;
          }),
        handleRequestPermission: handled,
        handleElicitation: handled,
        handleReadTextFile: handled,
        handleWriteTextFile: handled,
        handleCreateTerminal: handled,
        handleTerminalOutput: handled,
        handleTerminalWaitForExit: handled,
        handleTerminalKill: handled,
        handleTerminalRelease: handled,
        handleUnknownExtRequest: handled,
      } satisfies TextRuntime),
  };
  const textGeneration = yield* makeAntigravityTextGeneration(options);
  const result = yield* textGeneration
    .generateThreadTitle({
      cwd: userHome,
      message: "Repair Google login",
      modelSelection: {
        instanceId: baseOptions.instanceId,
        model: ANTIGRAVITY_DEFAULT_MODEL,
      },
    })
    .pipe(Effect.result);
  return { result: result._tag, started };
});

describe("Antigravity CLI runtime", () => {
  it.effect("opens CLI sessions without additional directories", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const attachmentsDir = path.join("state", "attachments");
      const sent = (
        runtimeState: ReturnType<typeof cliRuntimeState | typeof managedRuntimeState>,
      ) =>
        Effect.gen(function* () {
          let directories: RuntimeInput["additionalDirectories"];
          const options = {
            ...baseOptions,
            host: { paths: { attachmentsDir } } as never,
            runtimeState,
            makeRuntime: (input: RuntimeInput) => {
              directories = input.additionalDirectories;
              return Effect.succeed({} as AcpSessionRuntime.AcpSessionRuntime["Service"]);
            },
          };
          const flavor = makeAntigravityAcpAdapterFlavor(options);
          yield* flavor.makeRuntime({ cwd: "workspace" } as Parameters<
            typeof flavor.makeRuntime
          >[0]);
          return directories ?? [];
        });

      assert.deepEqual(yield* sent(managedRuntimeState("profile")), [attachmentsDir]);
      assert.deepEqual(yield* sent(cliRuntimeState(path, "home")), []);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("fails a CLI turn whose session log ends in an upstream API error", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userHome = yield* fileSystem.makeTempDirectoryScoped();
      const sessionId = "e6aba774-5472-4277-b6ee-27b2e05570a7";
      const conversations = path.join(userHome, ".gemini", "antigravity-cli", "conversations");
      yield* fileSystem.makeDirectory(conversations, { recursive: true });
      const options = { ...baseOptions, runtimeState: cliRuntimeState(path, userHome) };
      const { watchPromptOutcome } = makeAntigravityAcpAdapterFlavor(options);
      assert.isDefined(watchPromptOutcome);

      const check = yield* watchPromptOutcome!(sessionId);
      const database = new NodeSqlite.DatabaseSync(path.join(conversations, `${sessionId}.db`));
      try {
        database.exec(
          "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
        );
        database.prepare("INSERT INTO steps VALUES (?, ?, ?)").run(0, ERROR_MESSAGE, CLI_API_ERROR);
      } finally {
        database.close();
      }
      const result: EffectAcpSchema.PromptResponse = { stopReason: "end_turn" };

      assert.deepEqual(yield* check(result), {
        class: "provider_error",
        message: "User location is not supported for the API use.",
        code: "FAILED_PRECONDITION",
        retryable: false,
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keys the CLI account by the refresh token in the CLI's own login file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userHome = yield* fileSystem.makeTempDirectoryScoped();
      const options = {
        ...baseOptions,
        runtimeState: cliRuntimeState(path, userHome),
        digest: yield* Digest.Digest,
        fileSystem,
        path,
      };
      const { readAccount } = makeAntigravityAcpAdapterFlavor(options);
      assert.isDefined(readAccount);
      const tokenPath = path.join(
        userHome,
        ".gemini",
        "antigravity-cli",
        "antigravity-oauth-token",
      );
      yield* fileSystem.makeDirectory(path.dirname(tokenPath), { recursive: true });
      const writeLogin = (token: { access_token: string; refresh_token: string }) =>
        fileSystem.writeFileString(
          tokenPath,
          JSON.stringify({
            token: { ...token, token_type: "Bearer", expiry: "2030-01-01T00:00:00Z" },
            auth_method: "oauth",
            id_token_email: "user@example.com",
          }),
        );

      assert.isTrue(Option.isNone(yield* readAccount!), "missing");
      yield* writeLogin({ access_token: "access-1", refresh_token: "refresh-a" });
      const first = yield* readAccount!;
      assert.match(Option.getOrUndefined(first) ?? "none", /^[0-9a-f]{64}$/);
      yield* writeLogin({ access_token: "access-2", refresh_token: "refresh-a" });
      assert.deepEqual(yield* readAccount!, first, "access token refresh");
      yield* writeLogin({ access_token: "access-2", refresh_token: "refresh-b" });
      const second = yield* readAccount!;
      assert.isTrue(Option.isSome(second));
      assert.notDeepEqual(second, first, "another login");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it("sends session instructions as a system prompt append when the agent advertises it", () => {
    const initialize = (append: boolean): EffectAcpSchema.InitializeResponse => ({
      protocolVersion: 1,
      agentInfo: { name: "Antigravity ACP Server", version: "1.5.5" },
      agentCapabilities: { _meta: { antigravity: { systemPrompt: { append } } } },
    });
    const { sessionCarriesPullRequestLinking } = makeAntigravityAcpAdapterFlavor(baseOptions);

    assert.deepEqual(antigravitySessionMeta(initialize(true), "<instructions/>"), {
      antigravity: { systemPrompt: { append: "<instructions/>" } },
    });
    assert.isTrue(sessionCarriesPullRequestLinking?.(initialize(true)));
    assert.isUndefined(antigravitySessionMeta(initialize(false), "<instructions/>"));
    assert.isFalse(sessionCarriesPullRequestLinking?.(initialize(false)));
  });

  it.effect("compacts a CLI session with the bare /compact prompt", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const promptReceived = yield* Deferred.make<Parameters<RuntimeService["prompt"]>[0]>();
      const instanceId = ProviderInstanceId.make("antigravity-cli-compaction-test");
      const options = {
        instanceId,
        profileDirectory: "antigravity-profile-unused",
        runtimeState: cliRuntimeState(path, "home"),
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input: RuntimeInput) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1", T3_ACP_HANG_PROMPT_FOREVER: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              prompt: (request) =>
                Deferred.succeed(promptReceived, request).pipe(
                  Effect.andThen(runtime.prompt(request)),
                ),
            })),
          ),
        withProcess: ((_stop, task) => task) as Parameters<
          typeof makeAntigravityAdapterV2
        >[0]["withProcess"],
        defaultModel: Effect.undefined,
      };
      const adapter = yield* makeAntigravityAdapterV2(options);
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-compact-" });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const threadId = ThreadId.make("thread-antigravity-cli-compaction");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-cli-compaction"),
        modelSelection,
        runtimePolicy,
      });
      assert.isDefined(session.compactThread, "the CLI runtime offers compaction");
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.compactThread!({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-cli-compaction"),
          title: "Antigravity CLI compaction",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
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
        threadId,
        runId: RunId.make("run-antigravity-cli-compaction"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-cli-compaction"),
        rootNodeId: NodeId.make("node-antigravity-cli-compaction"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-cli-compaction"),
          text: " /compact ",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      }).pipe(Effect.forkScoped);

      // The first prompt of a process is the one that would carry T3's instruction prefix.
      assert.deepEqual((yield* Deferred.await(promptReceived)).prompt, [
        { type: "text", text: "/compact" },
      ]);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.effect("starts no helper turn beside hooks in the CLI's own config folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userHome = yield* fileSystem.makeTempDirectoryScoped();
      const config = path.join(userHome, ".gemini", "config");
      yield* fileSystem.makeDirectory(config, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(config, "hooks.json"),
        '{"default":{"PreInvocation":[{"command":"do-not-run"}]}}',
      );
      const hooked = yield* cliHelperTurn(userHome, HELPER_SESSION);
      assert.equal(hooked.result, "Failure");
      assert.isFalse(hooked.started, "no agent started");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reads CLI limits with the CLI's saved access until that access expires", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userHome = yield* fileSystem.makeTempDirectoryScoped();
      const appDirectory = path.join(userHome, ".gemini", "antigravity-cli");
      yield* fileSystem.makeDirectory(appDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(appDirectory, "antigravity-oauth-token"),
        JSON.stringify({
          token: {
            access_token: "cli-access",
            token_type: "Bearer",
            refresh_token: "cli-refresh",
            expiry: "1970-01-01T01:00:00.123456789Z",
            expires_in: 3599,
          },
          auth_method: "oauth",
          id_token_email: "user@example.com",
        }),
      );
      const requests: Array<string> = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          assert.equal(request.headers.authorization, "Bearer cli-access");
          return HttpClientResponse.fromWeb(
            request,
            request.url.endsWith(":retrieveUserQuotaSummary")
              ? Response.json({
                  buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.75 }],
                })
              : Response.json({}, { status: 403 }),
          );
        }),
      );
      const options = {
        profileDirectory: path.join(userHome, "profile-unused"),
        authMethod: "oauth-personal" as const,
        runtimeState: cliRuntimeState(path, userHome),
      };
      const { probe } = yield* makeAntigravityUsageProbe(options).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );

      const fresh = yield* probe;
      assert.isUndefined(fresh.unavailable);
      assert.deepEqual(
        fresh.windows.map((window) => [window.id, window.usedPercent]),
        [["gemini-5h", 25]],
      );
      assert.isFalse(
        requests.some((url) => url.endsWith("/token")),
        "the CLI's login has no OAuth client to refresh with",
      );

      yield* TestClock.setTime(3_600_000 - 30_000);
      const sent = requests.length;
      const expired = yield* probe;
      assert.deepEqual(expired.windows, []);
      assert.equal(expired.unavailable?.reason, "unsupported");
      assert.match(expired.unavailable?.message ?? "", /Antigravity CLI/);
      assert.equal(requests.length, sent, "no request with expired access");
      assert.notMatch(JSON.stringify([fresh, expired]), /cli-access|cli-refresh/);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
