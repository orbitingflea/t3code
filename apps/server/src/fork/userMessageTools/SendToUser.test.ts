import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as SendToUser from "./SendToUser.ts";

const threadScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("send-to-user-environment"),
  requestNamespace: "send-to-user-session",
  thread: {
    threadId: ThreadId.make("send-to-user-thread"),
    providerSessionId: "send-to-user-session",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "send-to-user", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "send-to-user", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layer = McpHttpServer.toolkitRegistration(
  SendToUser.SendToUserToolkit,
  SendToUser.layerHandlers,
).pipe(Layer.provideMerge(McpHttpServer.layerInProcessMcpServer));

const send = (text: string, scope: McpInvocationContext.McpInvocationScope = threadScope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "send_to_user", arguments: { text } })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

it.effect("shows the message to the user without needing any capability", () =>
  Effect.gen(function* () {
    const result = yield* send("The tests pass.");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ ok: true, message: "Shown to the user." });
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a caller outside a thread", () =>
  Effect.gen(function* () {
    const result = yield* send("Hello", { ...threadScope, thread: undefined });
    expect(result.isError).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect.each<readonly [string, string, boolean]>([
  ["12,000 ASCII characters", "a".repeat(12_000), false],
  ["12,001 ASCII characters", "a".repeat(12_001), true],
  ["4,001 Chinese characters, over 12,000 bytes", "汉".repeat(4_001), true],
  ["an empty message", "", true],
  ["6,000 backslashes, 12,000 bytes once JSON-escaped", "\\".repeat(6_000), false],
  ["9,000 backslashes, 18,000 bytes once JSON-escaped", "\\".repeat(9_000), true],
])("checks the size of %s", ([_name, text, refused]) =>
  Effect.gen(function* () {
    const result = yield* send(text).pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(refused);
  }).pipe(Effect.provide(layer)),
);

it.effect("tells the agent that escaping counts toward the limit", () =>
  Effect.gen(function* () {
    const error = yield* send("\\".repeat(9_000)).pipe(Effect.flip);
    expect(error.message).toContain("once JSON-escaped");
  }).pipe(Effect.provide(layer)),
);

it.effect("advertises the size limit", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tool = server.tools.find((entry) => entry.tool.name === "send_to_user")?.tool;
    expect(tool?.inputSchema).toMatchObject({
      properties: { text: { maxLength: 12_000 } },
      required: ["text"],
    });
  }).pipe(Effect.provide(layer)),
);
