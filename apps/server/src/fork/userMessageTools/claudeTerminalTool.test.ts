import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the Claude Agent SDK's spawn hook takes a process with Node streams
import * as NodeStream from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as PortScanner from "../../preview/PortScanner.ts";

// Answers each control request with success and exits when its stdin ends.
const fakeClaudeCli = () => {
  const spawns: Array<SpawnOptions> = [];
  const spawn = (options: SpawnOptions): SpawnedProcess => {
    spawns.push(options);
    const stdin = new NodeStream.PassThrough();
    const stdout = new NodeStream.PassThrough();
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      killed: false,
      exitCode: null as number | null,
      kill: () => {
        stdout.end();
        child.emit("exit", null, "SIGTERM");
        return true;
      },
    });
    let pending = "";
    stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (frame.type !== "control_request") continue;
        const response = {
          subtype: "success",
          request_id: frame.request_id,
          response:
            frame.request.subtype === "mcp_set_servers"
              ? { added: [], removed: [], errors: {} }
              : {},
        };
        stdout.write(`${JSON.stringify({ type: "control_response", response })}\n`);
      }
    });
    stdin.on("end", () => {
      stdout.end();
      child.emit("exit", 0, null);
    });
    return child;
  };
  return { spawn, spawns };
};

it.effect(
  "starts the Claude CLI with send_to_user and replace_send_to_user as terminal tools",
  () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli();
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      const session = yield* runner.open({
        threadId: ThreadId.make("thread-claude-terminal-tool"),
        providerSessionId: ProviderSessionId.make("provider-session-claude-terminal-tool"),
        options: {
          ...ClaudeAdapterV2.makeClaudeQueryOptions({
            modelSelection: {
              instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
              model: "claude-sonnet-4-6",
            },
            nativeThreadId: "native-thread-claude-terminal-tool",
            title: "Terminal tool",
            resume: false,
            cwd: null,
            environment: { PATH: "/usr/bin" },
          }),
          pathToClaudeCodeExecutable: "/opt/claude/cli.js",
          spawnClaudeCodeProcess: cli.spawn,
        },
      });
      yield* session.close;
      assert.equal(
        cli.spawns[0]?.env.CLAUDE_CODE_TERMINAL_MCP_TOOLS,
        "mcp__t3-code__send_to_user,mcp__t3-code__replace_send_to_user",
      );
    }).pipe(
      Effect.provide(ClaudeAdapterV2.layerQueryRunner.pipe(Layer.provide(PortScanner.layerTest))),
      Effect.provideService(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
);
