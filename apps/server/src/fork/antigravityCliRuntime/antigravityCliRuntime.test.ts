import * as NodeSqlite from "node:sqlite";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/compat";

import { makeAntigravityAcpAdapterFlavor } from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { antigravitySessionMeta } from "../../provider/acp/AntigravityAcpSupport.ts";

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
});
