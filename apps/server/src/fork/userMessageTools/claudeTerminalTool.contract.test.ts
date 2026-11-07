import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { claudeTerminalToolEnvironment } from "./claudeTerminalTool.ts";

const CLAUDE_BINARY = process.env.T3_CLAUDE_CONTRACT_BINARY ?? "claude";
const PATH = process.env.PATH;
const SEND = "mcp__t3-code__send_to_user";
const REPLACE = "mcp__t3-code__replace_send_to_user";
/** The fake server refuses a call with this text, as the real one refuses a second send. */
const REFUSED_TEXT = "Refuse this.";
const INJECTED_TEXT = "Your previous response had no visible output";

// CI has no Claude CLI, so these tests run only where one is installed.
const cliInstalled = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cli = yield* spawner.spawn(
    ChildProcess.make(CLAUDE_BINARY, ["--version"], {
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
const CLI_MISSING = `Install the Claude CLI, or set T3_CLAUDE_CONTRACT_BINARY, to run this test.`;

const MCP_SERVER = `
import * as Readline from "node:readline";
for await (const line of Readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const result =
    message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "t3-code", version: "1" } }
      : message.method === "tools/list"
        ? { tools: ["send_to_user", "replace_send_to_user"].map((name) => ({ name, description: "Show the user a message.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } })) }
        : message.params.arguments.text === ${JSON.stringify(REFUSED_TEXT)}
          ? { content: [{ type: "text", text: "Refused." }], isError: true }
          : { content: [{ type: "text", text: "Shown to the user." }] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
}
`;

type Reply = {
  readonly blocks: ReadonlyArray<"send" | "replace" | "refused" | "thinking" | "text">;
};
const send: Reply = { blocks: ["send"] };
const replace: Reply = { blocks: ["replace"] };
const refused: Reply = { blocks: ["refused"] };
const silent: Reply = { blocks: ["thinking"] };
const text: Reply = { blocks: ["text"] };

const replyEvents = (reply: Reply, index: number): ReadonlyArray<object> => [
  {
    type: "message_start",
    message: {
      id: `msg_${index}`,
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
  ...reply.blocks.flatMap((block, blockIndex) => {
    const frame = { index: blockIndex };
    if (block === "thinking") {
      return [
        {
          ...frame,
          type: "content_block_start",
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          ...frame,
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "Sent." },
        },
        {
          ...frame,
          type: "content_block_delta",
          delta: { type: "signature_delta", signature: "c2ln" },
        },
        { ...frame, type: "content_block_stop" },
      ];
    }
    if (block === "text") {
      return [
        { ...frame, type: "content_block_start", content_block: { type: "text", text: "" } },
        { ...frame, type: "content_block_delta", delta: { type: "text_delta", text: "Done." } },
        { ...frame, type: "content_block_stop" },
      ];
    }
    return [
      {
        ...frame,
        type: "content_block_start",
        content_block: {
          type: "tool_use",
          id: `toolu_${index}`,
          name: block === "replace" ? REPLACE : SEND,
          input: {},
        },
      },
      {
        ...frame,
        type: "content_block_delta",
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ text: block === "refused" ? REFUSED_TEXT : "Hello" }),
        },
      },
      { ...frame, type: "content_block_stop" },
    ];
  }),
  {
    type: "message_delta",
    delta: {
      stop_reason: reply.blocks.some((block) => block !== "thinking" && block !== "text")
        ? "tool_use"
        : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
];

// Plays `script` as the model and returns each request's last message, as the CLI sent it.
const runTurn = (script: ReadonlyArray<Reply>, environment: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const server = yield* HttpServer.HttpServer;
    const lastMessages: Array<string> = [];
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = JSON.parse((yield* request.text) || "{}");
        if (request.url.includes("count_tokens") || (body.max_tokens ?? 1) <= 1) {
          return HttpServerResponse.jsonUnsafe({ input_tokens: 1 });
        }
        const index = lastMessages.length;
        lastMessages.push(JSON.stringify(body.messages.at(-1)));
        return HttpServerResponse.text(
          replyEvents(script[index] ?? text, index)
            .map(
              (event) => `event: ${Reflect.get(event, "type")}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { contentType: "text/event-stream" },
        );
      }),
    );
    if (!NetAddress.isInetAddress(server.address)) {
      return yield* Effect.die(new Error("Expected a TCP address"));
    }
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-contract-" });
    yield* fs.writeFileString(path.join(folder, "mcp.mjs"), MCP_SERVER);
    yield* fs.writeFileString(
      path.join(folder, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "t3-code": { command: process.execPath, args: [path.join(folder, "mcp.mjs")] },
        },
      }),
    );
    yield* fs.writeFileString(
      path.join(folder, "settings.json"),
      JSON.stringify({ permissions: { allow: [SEND, REPLACE] } }),
    );
    const cli = yield* spawner.spawn(
      ChildProcess.make(
        CLAUDE_BINARY,
        [
          "-p",
          "Say hello.",
          "--model",
          "claude-haiku-4-5-20251001",
          "--mcp-config",
          path.join(folder, "mcp.json"),
          "--strict-mcp-config",
          "--settings",
          path.join(folder, "settings.json"),
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
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address.port}`,
            ANTHROPIC_API_KEY: "contract-test-not-a-key",
            ENABLE_TOOL_SEARCH: "false",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_AUTOUPDATER: "1",
            ...environment,
          },
        },
      ),
    );
    yield* cli.exitCode;
    return lastMessages;
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer)),
  );

const injectedCount = (lastMessages: ReadonlyArray<string>) =>
  lastMessages.filter((message) => message.includes(INJECTED_TEXT)).length;

it.live(
  "the CLI ends a turn on a silent stop after a send, and keeps working after a send before it",
  (ctx) =>
    Effect.gen(function* () {
      if (!(yield* cliInstalled)) return ctx.skip(CLI_MISSING);
      const lastMessages = yield* runTurn([send, send, silent], claudeTerminalToolEnvironment);
      expect(injectedCount(lastMessages)).toBe(0);
      expect(lastMessages).toHaveLength(3);
    }),
);

it.live("the CLI injects its text when the setting is not set", (ctx) =>
  Effect.gen(function* () {
    if (!(yield* cliInstalled)) return ctx.skip(CLI_MISSING);
    const lastMessages = yield* runTurn([send, silent, text], {});
    expect(injectedCount(lastMessages)).toBe(1);
    expect(lastMessages).toHaveLength(3);
  }),
);

it.live("the CLI ends a turn on a silent stop after a rewrite, as after a send", (ctx) =>
  Effect.gen(function* () {
    if (!(yield* cliInstalled)) return ctx.skip(CLI_MISSING);
    const lastMessages = yield* runTurn([replace, silent], claudeTerminalToolEnvironment);
    expect(injectedCount(lastMessages)).toBe(0);
    expect(lastMessages).toHaveLength(2);
  }),
);

it.live("the CLI does not take a refused send for the reply", (ctx) =>
  Effect.gen(function* () {
    if (!(yield* cliInstalled)) return ctx.skip(CLI_MISSING);
    const lastMessages = yield* runTurn([refused, silent, text], claudeTerminalToolEnvironment);
    expect(injectedCount(lastMessages)).toBe(1);
    expect(lastMessages).toHaveLength(3);
  }),
);
