import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { makeCodexTextGeneration } from "../textGeneration/CodexTextGeneration.ts";
import {
  applyChanges,
  installedRunnerFiles,
  planInstall,
  resolveHomes,
} from "./agentHooks/installer.ts";

// The contract test runs the real CLI. CI has no Codex CLI, so it runs only where one is.
const CODEX_BINARY = process.env.T3_CODEX_CONTRACT_BINARY ?? "codex";
const PATH = process.env.PATH ?? "";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const MODEL = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4-mini");
const TITLE_REPLY = JSON.stringify({ title: "Hooks stay off" });

const AUTH = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "contract-test-not-a-key" });

const refusingHookFile = (firedFile: string): string =>
  JSON.stringify({
    version: 1,
    hooks: {
      refuse: {
        events: ["PromptSubmit"],
        command: [
          "/bin/sh",
          "-c",
          'echo refused >> "$1"; echo refused >&2; exit 2',
          "refuse",
          firedFile,
        ],
      },
    },
  });

const CODEX_REPLY = [
  { type: "response.created", response: { id: "resp_0" } },
  {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id: "msg_0",
      content: [{ type: "output_text", text: TITLE_REPLY }],
    },
  },
  {
    type: "response.completed",
    response: {
      id: "resp_0",
      usage: {
        input_tokens: 1,
        input_tokens_details: null,
        output_tokens: 1,
        output_tokens_details: null,
        total_tokens: 2,
      },
    },
  },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

const layer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-codex-helper-hooks-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("the Codex text-generation call", (it) => {
  it.effect("turns hooks off after launch arguments that turn them on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-helper-hooks-" });
      const argsFile = path.join(folder, "args.json");
      const binaryPath = writeFakeCli({
        directory: path.join(folder, "bin"),
        name: "codex",
        source: [
          'import * as NodeFS from "node:fs";',
          "const args = process.argv.slice(2);",
          'if (args.includes("mcp")) { process.stdout.write("[]"); process.exit(0); }',
          `NodeFS.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));`,
          `NodeFS.writeFileSync(args[args.indexOf("--output-last-message") + 1], ${JSON.stringify(TITLE_REPLY)});`,
        ].join("\n"),
      });
      const userArgs = ["--enable", "hooks", "--config", "features.hooks=true"];
      const textGeneration = yield* makeCodexTextGeneration(
        decodeCodexSettings({ binaryPath, launchArgs: userArgs.join(" ") }),
        { PATH },
      );

      yield* textGeneration.generateThreadTitle({
        cwd: folder,
        message: "Name this thread",
        modelSelection: MODEL,
      });

      const args = yield* fs
        .readFileString(argsFile)
        .pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))),
        );
      expect(args.slice(1, 1 + userArgs.length)).toEqual(userArgs);
      const disable = args.lastIndexOf("--disable");
      expect(disable).toBeGreaterThan(userArgs.length);
      expect(args[disable + 1]).toBe("hooks");
    }).pipe(Effect.scoped),
  );
});

it.live(
  "the Codex text-generation call is not stopped by a unified hook that refuses the prompt of a plain codex exec",
  (ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const installed = yield* spawner
        .spawn(
          ChildProcess.make(CODEX_BINARY, ["--version"], { stdout: "ignore", stderr: "ignore" }),
        )
        .pipe(
          Effect.flatMap((cli) => cli.exitCode),
          Effect.map((code) => Number(code) === 0),
          Effect.orElseSucceed(() => false),
        );
      if (!installed) return ctx.skip(`Install the ${CODEX_BINARY} CLI to run this test.`);

      const server = yield* HttpServer.HttpServer;
      let modelRequests = 0;
      yield* server.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") return HttpServerResponse.jsonUnsafe({}, { status: 404 });
          modelRequests += 1;
          return HttpServerResponse.text(CODEX_REPLY, { contentType: "text/event-stream" });
        }),
      );
      if (!NetAddress.isInetAddress(server.address)) {
        return yield* Effect.die(new Error("Expected a TCP address"));
      }
      const apiUrl = `http://127.0.0.1:${server.address.port}/v1`;

      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-helper-hooks-" });
      const codexHome = path.join(home, ".codex");
      const hooksDir = path.join(home, ".agents", "hooks");
      const firedFile = path.join(home, "fired");
      const env = { HOME: home, PATH, CODEX_HOME: codexHome };
      yield* fs.makeDirectory(codexHome);
      yield* fs.makeDirectory(hooksDir, { recursive: true });
      yield* fs.writeFileString(path.join(codexHome, "auth.json"), AUTH);
      yield* fs.writeFileString(path.join(hooksDir, "hooks.json"), refusingHookFile(firedFile));
      applyChanges(
        planInstall(
          resolveHomes(env),
          installedRunnerFiles(path.join(import.meta.dirname, "agentHooks")),
        ).changes,
      );
      const fired = fs.readFileString(firedFile).pipe(Effect.orElseSucceed(() => ""));

      const plain = yield* spawner.spawn(
        ChildProcess.make(
          CODEX_BINARY,
          ["exec", "--skip-git-repo-check", "-c", `openai_base_url="${apiUrl}"`, "Say hello."],
          { cwd: home, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        ),
      );
      yield* plain.exitCode;
      expect(yield* fired).toBe("refused\n");
      expect(modelRequests).toBe(0);

      const textGeneration = yield* makeCodexTextGeneration(
        decodeCodexSettings({
          binaryPath: CODEX_BINARY,
          homePath: codexHome,
          launchArgs: `--config 'openai_base_url="${apiUrl}"'`,
        }),
        env,
      );
      const result = yield* textGeneration.generateThreadTitle({
        cwd: home,
        message: "Name this thread",
        modelSelection: MODEL,
      });
      expect(result.title).toBe("Hooks stay off");
      expect(yield* fired).toBe("refused\n");
      expect(modelRequests).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, NodeHttpServer.layerTest))),
);
