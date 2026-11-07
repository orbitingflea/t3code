import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { DisplayModeWrap } from "../displayModeWrap/DisplayModeWrap.ts";
import * as SendToUser from "./SendToUser.ts";

const normalThread = ThreadId.make("send-to-user-thread");
const messagesThread = ThreadId.make("send-to-user-thread:messages-only");
const dashboardThread = ThreadId.make("send-to-user-thread:messages-dashboard");

const scopeFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("send-to-user-environment"),
  requestNamespace: "send-to-user-session",
  thread: {
    threadId,
    providerSessionId: "send-to-user-session",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(),
});
const threadScope = scopeFor(normalThread);
const clientWith = (toolUseId?: string) =>
  McpSchema.McpServerClient.of({
    clientId: 1,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
    clientInfo: { name: "send-to-user", version: "1" },
    initializePayload: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "send-to-user", version: "1" },
    },
    ...(toolUseId === undefined ? {} : { requestMetadata: { "claudecode/toolUseId": toolUseId } }),
    getClient: Effect.die("unused"),
  });

const time = DateTime.makeUnsafe("2026-11-07T00:00:00.000Z");
let ordinal = 0;
const base = (id: string, status: OrchestrationV2TurnItem["status"] = "completed") => ({
  id: TurnItemId.make(id),
  threadId: messagesThread,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: {
    driver: ProviderDriverKind.make("claudeAgent"),
    nativeId: `toolu_${id}`,
    strength: "strong" as const,
  },
  parentItemId: null,
  ordinal: ordinal++,
  status,
  title: null,
  startedAt: time,
  completedAt: time,
  updatedAt: time,
});
const typed = (id: string, text: string, creationSource: "web" | "server" = "web") =>
  ({
    ...base(id),
    type: "user_message",
    messageId: MessageId.make(id),
    text,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource,
  }) satisfies OrchestrationV2TurnItem;
const sent = (id: string, text: string, status: OrchestrationV2TurnItem["status"] = "completed") =>
  ({
    ...base(id, status),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__send_to_user",
    input: { text },
  }) satisfies OrchestrationV2TurnItem;
const rewritten = (id: string, text: string) =>
  ({
    ...base(id),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__replace_send_to_user",
    input: { user_message: "", old_text: "", new_text: text },
  }) satisfies OrchestrationV2TurnItem;

/** The shown history that each thread's reader returns, oldest first. */
let history: ReadonlyArray<OrchestrationV2TurnItem> = [];

const layer = McpHttpServer.toolkitRegistration(
  SendToUser.SendToUserToolkit,
  SendToUser.layerHandlers,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(
    ServerSettings.layerTest({
      threadDisplayModes: {
        [messagesThread]: "messages-only",
        [dashboardThread]: "messages-dashboard",
      },
    }),
  ),
  Layer.provide(
    Layer.mock(DisplayModeWrap)({
      latestShownItems: () => Effect.succeed(history),
      forgetNotesAfterCompaction: () => (ingest) => ingest,
    }),
  ),
);

const call = (
  name: "send_to_user" | "replace_send_to_user",
  args: Record<string, unknown>,
  options: { readonly threadId?: ThreadId; readonly toolUseId?: string } = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      scopeFor(options.threadId ?? messagesThread),
    ),
    Effect.provideService(McpSchema.McpServerClient, clientWith(options.toolUseId)),
  );

const send = (text: string, scope: McpInvocationContext.McpInvocationScope = threadScope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "send_to_user", arguments: { text } })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, clientWith()),
  );

/** The text of a refused call, which the agent reads. */
const refusalText = (result: McpSchema.CallToolResult) => {
  expect(result.isError).toBe(true);
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
};

const SHOWN = {
  ok: true,
  message: "Shown to the user. If you are done, end your turn with no text.",
};

it.effect("shows the message to the user without needing any capability", () =>
  Effect.gen(function* () {
    const result = yield* send("The tests pass.");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      ok: true,
      message: "Shown to the user. If you are done, end your turn with no text.",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a caller outside a thread", () =>
  Effect.gen(function* () {
    const result = yield* send("Hello", { ...threadScope, thread: undefined });
    expect(result.isError).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect.each<readonly [string, string, boolean]>([
  ["11,000 ASCII characters", "a".repeat(11_000), false],
  ["11,001 ASCII characters", "a".repeat(11_001), true],
  ["3,667 Chinese characters, over 11,000 bytes", "汉".repeat(3_667), true],
  ["an empty message", "", true],
  ["5,500 backslashes, 11,000 bytes once JSON-escaped", "\\".repeat(5_500), false],
  ["5,501 backslashes, 11,002 bytes once JSON-escaped", "\\".repeat(5_501), true],
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
      properties: { text: { maxLength: 11_000 } },
      required: ["text"],
    });
  }).pipe(Effect.provide(layer)),
);

describe("one send per typed message", () => {
  it.effect("shows the first send after the user's message, as sends before it do not count", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("s1", "On it."), typed("u2", "Any news?")];
      const result = yield* call("send_to_user", { text: "Done." });
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a second send with the latest messages and the current one", () =>
    Effect.gen(function* () {
      history = [
        typed("u1", "Fix the build."),
        sent("s1", "On it."),
        typed("u2", "Any news?"),
        typed("r", "Continue where you left off.", "server"),
        sent("s2", "Still working."),
        rewritten("w2", "Still working, halfway."),
      ];
      const error = refusalText(yield* call("send_to_user", { text: "Done." }));
      expect(error).toBe(
        [
          "Refused: you already sent the user a message after their last one, and this thread allows one per message of theirs. To change it, call replace_send_to_user.",
          "Latest messages between you and the user:",
          "[you] On it.",
          "[user] Any news?",
          "[you] Still working, halfway.",
          "Your current message, as old_text:",
          "Still working, halfway.",
        ].join("\n"),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("limits Messages + Dashboard too, and not Normal", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("s1", "On it.")];
      const dashboard = yield* call(
        "send_to_user",
        { text: "Done." },
        { threadId: dashboardThread },
      );
      expect(dashboard.isError).toBe(true);
      const normal = yield* call("send_to_user", { text: "Done." }, { threadId: normalThread });
      expect(normal.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("counts another send still running when the call names its own tool use", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("other", "On it.", "running")];
      const refused = yield* call("send_to_user", { text: "Done." }, { toolUseId: "toolu_own" });
      expect(refused.isError).toBe(true);
      history = [typed("u1", "Fix the build."), sent("own", "Done.", "running")];
      const own = yield* call("send_to_user", { text: "Done." }, { toolUseId: "toolu_own" });
      expect(own.structuredContent).toEqual(SHOWN);
      history = [typed("u1", "Fix the build."), sent("other", "On it.", "failed")];
      const failed = yield* call("send_to_user", { text: "Done." }, { toolUseId: "toolu_own" });
      expect(failed.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("of two sends in one response, shows the first and refuses the second", () =>
    Effect.gen(function* () {
      history = [
        typed("u1", "Fix the build."),
        sent("first", "On it.", "running"),
        sent("second", "Done.", "running"),
      ];
      const first = yield* call("send_to_user", { text: "On it." }, { toolUseId: "toolu_first" });
      expect(first.structuredContent).toEqual(SHOWN);
      const second = yield* call("send_to_user", { text: "Done." }, { toolUseId: "toolu_second" });
      expect(second.isError).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ignores a message the user typed after the call started", () =>
    Effect.gen(function* () {
      history = [
        typed("u1", "Fix the build."),
        sent("own", "Done.", "running"),
        typed("u2", "Also run the tests."),
        sent("later", "Tests pass.", "completed"),
      ];
      const result = yield* call("send_to_user", { text: "Done." }, { toolUseId: "toolu_own" });
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "of two unnamed sends before either is stored, refuses the second for a few seconds",
    () =>
      Effect.gen(function* () {
        history = [typed("u1", "Fix the build.")];
        const first = yield* call("send_to_user", { text: "On it." });
        expect(first.structuredContent).toEqual(SHOWN);
        const second = yield* call("send_to_user", { text: "Done." });
        expect(second.isError).toBe(true);
        yield* TestClock.adjust("11 seconds");
        const later = yield* call("send_to_user", { text: "Done." });
        expect(later.structuredContent).toEqual(SHOWN);
        history = [typed("u1", "Fix the build."), sent("s1", "Done."), typed("u2", "Thanks.")];
        const afterTyping = yield* call("send_to_user", { text: "You're welcome." });
        expect(afterTyping.structuredContent).toEqual(SHOWN);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("counts only completed sends when the call does not name its tool use", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("other", "On it.", "running")];
      const result = yield* call("send_to_user", { text: "Done." });
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );
});

describe("replace_send_to_user", () => {
  const replace = (user_message: string, old_text: string, threadId = messagesThread) =>
    call(
      "replace_send_to_user",
      { user_message, old_text, new_text: "Done, and pushed." },
      {
        threadId,
      },
    );

  it.effect("accepts the user's message and the current message as the recap shows them", () =>
    Effect.gen(function* () {
      const long = "汉".repeat(700);
      history = [typed("u1", long), sent("s1", "On it.")];
      const result = yield* replace(`[user] ${"汉".repeat(666)}…[truncated]`, "[you] On it.");
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("compares old_text with the send's text after its earlier rewrites", () =>
    Effect.gen(function* () {
      history = [
        typed("u1", "Fix the build."),
        sent("s1", "The build passed on prototype/host. I will deploy after Chief says yes."),
        rewritten("w1", "Deployed. Next I clean up the old branches."),
      ];
      const stale = refusalText(
        yield* replace(
          "Fix the build.",
          "The build passed on prototype/host. I will deploy after Chief says yes.",
        ),
      );
      expect(stale).toMatch(/^Refused: old_text is \d+% like your current message; needs 70%\./);
      const current = yield* replace("Fix the build.", "Deployed; next I clean up old branches.");
      expect(current.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("matches the user's message in the form the agent got, with quote placeholders", () =>
    Effect.gen(function* () {
      const quote = serializeAssistantCitation({
        version: 1,
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("message"),
        text: "a long quoted sentence about the deploy order and the rollback plan",
        start: 0,
        end: 10,
        prefix: "",
        suffix: "",
      });
      history = [typed("u1", `Why ${quote}?`), sent("s1", "On it.")];
      const result = yield* replace("Why [assistant-quote-1]?", "On it.");
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a user_message unlike the user's last message, floored to whole percent", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("s1", "On it.")];
      // The longest common subsequence is "i the l.", 8 characters, against 14 + 17: 51.6%.
      const error = refusalText(yield* replace("Ship the release.", "On it."));
      expect(error.split("\n")[0]).toBe(
        "Refused: user_message is 51% like the user's last message; needs 70%.",
      );
      expect(error).toContain("[user] Fix the build.\n[you] On it.");
      expect(error.endsWith("Your current message, as old_text:\nOn it.")).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("expects an empty user_message when the user has typed nothing", () =>
    Effect.gen(function* () {
      history = [typed("r", "Continue where you left off.", "server"), sent("s1", "On it.")];
      const error = refusalText(yield* replace("Continue where you left off.", "On it."));
      expect(error.split("\n")[0]).toBe(
        "Refused: user_message is 0% like the user's last message; expected an empty string.",
      );
      const result = yield* replace("", "On it.");
      expect(result.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "accepts a message copied whole a little over 2000 bytes, comparing its first 2000",
    () =>
      Effect.gen(function* () {
        const long = "Fix the build and tell me what broke. ".repeat(65);
        history = [typed("u1", long), sent("s1", "On it.")];
        const result = yield* replace(long, "On it.");
        expect(result.structuredContent).toEqual(SHOWN);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses user_message and old_text over 2500 bytes once JSON-escaped", () =>
    Effect.gen(function* () {
      const typedText = "\\".repeat(1_250);
      const sentText = "a".repeat(2_500);
      history = [typed("u1", typedText), sent("s1", sentText)];
      const within = yield* replace(typedText, sentText);
      expect(within.structuredContent).toEqual(SHOWN);
      const user = yield* replace(`${typedText}\\`, sentText).pipe(Effect.flip);
      const old = yield* replace(typedText, `${sentText}a`).pipe(Effect.flip);
      expect([user.message, old.message]).toEqual([
        expect.stringContaining("Over 2000 bytes of UTF-8 once JSON-escaped"),
        expect.stringContaining("Over 2000 bytes of UTF-8 once JSON-escaped"),
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("checks new_text like a send's text", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("s1", "On it.")];
      const result = yield* call("replace_send_to_user", {
        user_message: "Fix the build.",
        old_text: "On it.",
        new_text: "a".repeat(11_001),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses when there is no send since the user's last message", () =>
    Effect.gen(function* () {
      history = [sent("s1", "On it."), typed("u1", "Fix the build.")];
      const error = refusalText(yield* replace("Fix the build.", "On it."));
      expect(error.split("\n")[0]).toBe(
        "Refused: you have sent no message since the user's last one, so there is nothing to replace. Use send_to_user.",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses outside Messages only and Messages + Dashboard", () =>
    Effect.gen(function* () {
      history = [typed("u1", "Fix the build."), sent("s1", "On it.")];
      const error = refusalText(yield* replace("Fix the build.", "On it.", normalThread));
      expect(error.split("\n")[0]).toBe(
        "Refused: replace_send_to_user works only in threads set to Messages only or Messages + Dashboard. Use send_to_user.",
      );
      const dashboard = yield* replace("Fix the build.", "On it.", dashboardThread);
      expect(dashboard.structuredContent).toEqual(SHOWN);
    }).pipe(Effect.provide(layer)),
  );
});
