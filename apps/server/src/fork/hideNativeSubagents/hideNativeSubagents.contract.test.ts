import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DELEGATE_ONLY_PROVIDERS } from "@t3tools/provider-core/server/fork/nativeSubagents";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// The settings that hide a provider's subagent tools are not part of a documented contract, so
// these tests run them against the real CLIs. CI has neither CLI, so they run only where one is.
const CLAUDE_BINARY = process.env.T3_CLAUDE_CONTRACT_BINARY ?? "claude";
const CODEX_BINARY = process.env.T3_CODEX_CONTRACT_BINARY ?? "codex";
const PATH = process.env.PATH;

const installed = (binary: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cli = yield* spawner.spawn(
      ChildProcess.make(binary, ["--version"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    return Number(yield* cli.exitCode) === 0;
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => false),
    Effect.provide(NodeServices.layer),
  );
const missing = (binary: string) => `Install the ${binary} CLI to run this test.`;

const sse = (events: ReadonlyArray<{ readonly type: string }>) =>
  HttpServerResponse.text(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { contentType: "text/event-stream" },
  );

const CLAUDE_REPLY = [
  {
    type: "message_start",
    message: {
      id: "msg_0",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
];

const CODEX_REPLY = [
  { type: "response.created", response: { id: "resp_0" } },
  {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id: "msg_0",
      content: [{ type: "output_text", text: "Done." }],
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
];

// Runs one turn of a CLI against a fake model API and returns the model requests the CLI sent.
const modelRequests = (
  reply: ReadonlyArray<{ readonly type: string }>,
  command: (input: {
    readonly folder: string;
    readonly apiUrl: string;
  }) => Effect.Effect<ChildProcess.Command, never, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const server = yield* HttpServer.HttpServer;
    const requests: Array<string> = [];
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const text = yield* request.text;
        const body = JSON.parse(text || "{}");
        if (request.method !== "POST") return HttpServerResponse.jsonUnsafe({}, { status: 404 });
        if (request.url.includes("count_tokens") || (body.max_tokens ?? 2) <= 1) {
          return HttpServerResponse.jsonUnsafe({ input_tokens: 1 });
        }
        requests.push(text);
        return sse(reply);
      }),
    );
    if (!NetAddress.isInetAddress(server.address)) {
      return yield* Effect.die(new Error("Expected a TCP address"));
    }
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3-subagent-contract-" });
    const cli = yield* spawner.spawn(
      yield* command({ folder, apiUrl: `http://127.0.0.1:${server.address.port}` }),
    );
    yield* cli.exitCode;
    return requests;
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer)),
  );

const claudeToolNames = (hidden: boolean) =>
  modelRequests(CLAUDE_REPLY, ({ folder, apiUrl }) =>
    Effect.succeed(
      ChildProcess.make(
        CLAUDE_BINARY,
        [
          "-p",
          "Say hello.",
          "--model",
          "claude-haiku-4-5-20251001",
          ...(hidden
            ? [
                `--disallowedTools=${DELEGATE_ONLY_PROVIDERS.claudeAgent.hide.disallowedTools.join(",")}`,
              ]
            : []),
        ],
        {
          cwd: folder,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          env: {
            HOME: folder,
            PATH,
            CLAUDE_CONFIG_DIR: folder,
            ANTHROPIC_BASE_URL: apiUrl,
            ANTHROPIC_API_KEY: "contract-test-not-a-key",
            ENABLE_TOOL_SEARCH: "false",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_AUTOUPDATER: "1",
            ...(hidden ? DELEGATE_ONLY_PROVIDERS.claudeAgent.hide.environment : {}),
          },
        },
      ),
    ),
  ).pipe(
    Effect.map((requests) =>
      requests.flatMap((request): ReadonlyArray<string> =>
        (JSON.parse(request).tools ?? []).map((tool: { readonly name: string }) => tool.name),
      ),
    ),
  );

it.live("the Claude CLI offers its subagent tools until T3 Code hides them", (ctx) =>
  Effect.gen(function* () {
    if (!(yield* installed(CLAUDE_BINARY))) return ctx.skip(missing(CLAUDE_BINARY));
    expect(yield* claudeToolNames(false)).toContain("Agent");
    const hidden = yield* claudeToolNames(true);
    expect(hidden).toContain("Bash");
    for (const tool of DELEGATE_ONLY_PROVIDERS.claudeAgent.hide.disallowedTools) {
      expect(hidden).not.toContain(tool);
    }
  }),
);

const CODEX_SUBAGENT_TOOLS = /spawn_agent|multi_agent_v1/;
const codexRequests = (hidden: boolean) =>
  modelRequests(CODEX_REPLY, ({ folder, apiUrl }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs
        .writeFileString(
          path.join(folder, "auth.json"),
          JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "contract-test-not-a-key" }),
        )
        .pipe(Effect.orDie);
      const config = {
        openai_base_url: `${apiUrl}/v1`,
        ...(hidden ? DELEGATE_ONLY_PROVIDERS.codex.hide.threadConfig : {}),
      };
      return ChildProcess.make(
        CODEX_BINARY,
        [
          "exec",
          "--skip-git-repo-check",
          ...Object.entries(config).flatMap(([key, value]) => [
            "-c",
            `${key}=${JSON.stringify(value)}`,
          ]),
          "Say hello.",
        ],
        {
          cwd: folder,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          env: { HOME: folder, PATH, CODEX_HOME: folder },
        },
      );
    }),
  ).pipe(Effect.map((requests) => requests.join("\n")));

it.live("the Codex CLI offers its subagent tools until T3 Code hides them", (ctx) =>
  Effect.gen(function* () {
    if (!(yield* installed(CODEX_BINARY))) return ctx.skip(missing(CODEX_BINARY));
    expect(yield* codexRequests(false)).toMatch(CODEX_SUBAGENT_TOOLS);
    const hidden = yield* codexRequests(true);
    expect(hidden).toContain("Say hello.");
    expect(hidden).not.toMatch(CODEX_SUBAGENT_TOOLS);
  }),
);
