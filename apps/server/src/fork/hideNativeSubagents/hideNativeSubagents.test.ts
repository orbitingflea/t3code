import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the Claude Agent SDK's spawn hook takes a process with Node streams
import * as NodeStream from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { NO_NATIVE_SUBAGENT_TOOL_LINE } from "@t3tools/provider-core/server/fork/nativeSubagents";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
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

const claudeOptions = (disallowedTools?: ReadonlyArray<string>) =>
  ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
      model: "claude-sonnet-4-6",
    },
    nativeThreadId: "native-thread-hidden-subagents",
    resume: false,
    cwd: null,
    environment: { PATH: "/usr/bin" },
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
  });

it.effect("starts the Claude CLI without its subagent and workflow tools", () =>
  Effect.gen(function* () {
    const cli = fakeClaudeCli();
    const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
    const session = yield* runner.open({
      threadId: ThreadId.make("thread-hidden-subagents"),
      providerSessionId: ProviderSessionId.make("provider-session-hidden-subagents"),
      options: {
        ...claudeOptions(["WebSearch"]),
        pathToClaudeCodeExecutable: "/opt/claude/cli.js",
        spawnClaudeCodeProcess: cli.spawn,
      },
    });
    yield* session.close;
    const spawned = cli.spawns[0];
    assert.include(
      spawned?.args ?? [],
      "--disallowedTools=Agent,Workflow,SendMessage,ListAgents,WebSearch",
    );
    assert.equal(spawned?.env.CLAUDE_CODE_DISABLE_WORKFLOWS, "1");
  }).pipe(
    Effect.provide(ClaudeAdapterV2.layerQueryRunner.pipe(Layer.provide(PortScanner.layerTest))),
    Effect.provideService(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

it("tells a Claude session to start every subagent with delegate_task", () => {
  const { systemPrompt } = claudeOptions();
  const append =
    typeof systemPrompt === "object" && "append" in systemPrompt ? systemPrompt.append : "";
  assert.include(append, NO_NATIVE_SUBAGENT_TOOL_LINE);
  assert.notInclude(append, "`Agent`");
});

it("starts every Codex thread with its subagent tools turned off", () => {
  assert.deepInclude(CodexAdapterV2.CODEX_THREAD_CONFIG, {
    "agents.enabled": false,
    "features.multi_agent_v2": false,
  });
});
