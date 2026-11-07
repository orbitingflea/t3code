import {
  type OrchestrationV2TurnItem,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import {
  displayEventFromTurnItem,
  foldCores,
  recapLine,
  recapText,
  REPLACE_SEND_TO_USER_TOOL_NAME,
  resolveDisplayMode,
  SEND_TO_USER_MAX_BYTES,
  SEND_TO_USER_TOOL_NAME,
  WRAPPED_CORE_COUNT,
} from "@t3tools/shared/displayModes";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import { TEXT_MATCH_MIN_RATIO, textSimilarity } from "@t3tools/shared/textMatch";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { DisplayModeWrap } from "../displayModeWrap/DisplayModeWrap.ts";

// The description goes before the checks: one set after a custom check is left out of the JSON schema.
const MessageText = Schema.String.annotate({
  description: `Markdown, at most ${SEND_TO_USER_MAX_BYTES} bytes of UTF-8 after JSON escaping. A quote, a backslash, a tab, or a line break counts as 2 bytes, and most other control characters count as 6.`,
}).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(SEND_TO_USER_MAX_BYTES),
  // A tool input over 16 KiB of JSON loses its text on the wire, so the check measures the escaped form.
  Schema.makeFilter((text: string) =>
    Buffer.byteLength(JSON.stringify(text), "utf8") - 2 <= SEND_TO_USER_MAX_BYTES
      ? true
      : `The message is over ${SEND_TO_USER_MAX_BYTES} bytes of UTF-8 once JSON-escaped (a quote, backslash, or control character takes 2 or more bytes). Shorten it or split it.`,
  ),
);

// Agents are told 2000 bytes and a little over still passes; 2500 + 2500 + SEND_TO_USER_MAX_BYTES
// keeps a replace call's input under the 16 KiB a tool input may take on the wire.
const MATCH_INPUT_TOLD_BYTES = 2000;
const MATCH_INPUT_MAX_BYTES = 2500;

const MatchInput = (description: string) =>
  Schema.String.annotate({ description }).check(
    Schema.makeFilter((text: string) =>
      Buffer.byteLength(JSON.stringify(text), "utf8") - 2 <= MATCH_INPUT_MAX_BYTES
        ? true
        : `Over ${MATCH_INPUT_TOLD_BYTES} bytes of UTF-8 once JSON-escaped. Pass the text as the recap shows it.`,
    ),
  );

/** How long an accepted send counts while its call is not yet in the history, for calls not named. */
const UNNAMED_SEND_HOLD_MS = 10_000;
const MIN_PERCENT = Math.round(TEXT_MATCH_MIN_RATIO * 100);
const SHOWN = {
  ok: true as const,
  message: "Shown to the user. If you are done, end your turn with no text.",
};

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerSettings.ServerSettingsService,
  DisplayModeWrap,
];

// The tools change only what the caller's thread shows, so read-only sandboxes and plan mode may use them.
const SendToUserTool = Tool.make(SEND_TO_USER_TOOL_NAME, {
  description:
    "Show the user a message in this thread. In a thread set to Messages only, this is the only output the user sees.",
  parameters: Schema.Struct({ text: MessageText }),
  success: Schema.Struct({ ok: Schema.Literal(true), message: Schema.String }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Send to user")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ReplaceSendToUserTool = Tool.make(REPLACE_SEND_TO_USER_TOOL_NAME, {
  description: `In threads set to Messages only or Messages + Dashboard, the user gets one message from you per message of theirs. This replaces that message in place. Pass the user's last message and your current message as the recap shows them (their words only), each at least ${MIN_PERCENT}% alike, and the whole new text.`,
  parameters: Schema.Struct({
    user_message: MatchInput(
      `The user's last message, at most ${MATCH_INPUT_TOLD_BYTES} bytes of UTF-8 after JSON escaping. An empty string if they have typed none.`,
    ),
    old_text: MatchInput(
      `Your current message to the user, at most ${MATCH_INPUT_TOLD_BYTES} bytes of UTF-8 after JSON escaping.`,
    ),
    new_text: MessageText,
  }),
  success: Schema.Struct({ ok: Schema.Literal(true), message: Schema.String }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Rewrite a message to the user")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const SendToUserToolkit = Toolkit.make(SendToUserTool, ReplaceSendToUserTool);

const isSendCall = (item: OrchestrationV2TurnItem) =>
  item.type === "dynamic_tool" && resolveT3McpToolId(item.toolName) === SEND_TO_USER_TOOL_NAME;

/**
 * What the thread shows since the user's last typed message. `ownItem` is the native id of the
 * calling tool use when the provider names it; only then do sends still running count, and only
 * items stored before the call's own, so of two sends in one response the first is shown, and a
 * message typed after the call started does not change the answer.
 */
function readTurn(shown: ReadonlyArray<OrchestrationV2TurnItem>, ownItem: string | undefined) {
  const ownAt =
    ownItem === undefined
      ? -1
      : shown.findIndex((item) => item.nativeItemRef?.nativeId === ownItem);
  const items = ownAt < 0 ? shown : shown.slice(0, ownAt);
  const events = items.flatMap((item) => {
    const event = displayEventFromTurnItem(item);
    return event === null ? [] : [event];
  });
  const cores = foldCores(events);
  const typedAt = cores.findLastIndex((core) => core.from === "user");
  const since = items.slice(
    items.findLastIndex((item) => displayEventFromTurnItem(item)?.type === "user") + 1,
  );
  return {
    latest: cores.slice(-WRAPPED_CORE_COUNT),
    typed: typedAt < 0 ? undefined : cores[typedAt],
    current: cores.slice(typedAt + 1).findLast((core) => core.from === "agent"),
    sends: since.filter((item) => {
      if (!isSendCall(item)) return false;
      if (ownItem === undefined) return displayEventFromTurnItem(item)?.type === "sent";
      return (
        item.nativeItemRef?.nativeId !== ownItem && displayEventFromTurnItem(item)?.type !== "other"
      );
    }).length,
  };
}

type Turn = ReturnType<typeof readTurn>;

const refusal = (
  code: OrchestratorMcpFailure["code"],
  reasons: ReadonlyArray<string>,
  turn: Turn,
) =>
  new OrchestratorMcpFailure({
    code,
    message: [
      `Refused: ${reasons.join(" ")}`,
      ...(turn.latest.length === 0
        ? []
        : ["Latest messages between you and the user:", ...turn.latest.map(recapLine)]),
      ...(turn.current === undefined
        ? []
        : ["Your current message, as old_text:", recapText(turn.current.text)]),
    ].join("\n"),
  });

/** A text the agent copied from a recap line, compared without the line's marks. */
const quoted = (text: string) =>
  recapText(text.replace(/^\[(?:user|you)\] /, "").replace(/…\[truncated\]$/, ""));

/** The user's message as the agent got it: each quote as a placeholder, with no citation block. */
function providerForm(text: string): string {
  const expanded = expandAssistantCitationsForProvider(text);
  return recapText(
    expanded === text ? text : expanded.slice(0, expanded.lastIndexOf("\n\n<assistant_citations>")),
  );
}

const percent = (similarity: number) => Math.floor(similarity * 100);

const orchestrationError = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

export const layerHandlers = McpToolAccess.toLayer(
  SendToUserToolkit,
  Effect.sync(() => {
    // Both tools decide on the thread's history, so calls of one thread take turns.
    const locks = new Map<ThreadId, Semaphore.Semaphore>();
    const lockFor = (threadId: ThreadId) => {
      let lock = locks.get(threadId);
      if (lock === undefined) locks.set(threadId, (lock = Semaphore.makeUnsafe(1)));
      return lock;
    };

    const callerThread = Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "This tool");
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
        Effect.mapError(orchestrationError),
      );
      return {
        threadId: thread.threadId,
        mode: resolveDisplayMode(settings.threadDisplayModes[thread.threadId]),
      };
    });

    // Claude Code names the tool use in the call's _meta, and a Claude item's native id is that id.
    const readThreadTurn = Effect.fn("SendToUser.readThreadTurn")(function* (threadId: ThreadId) {
      const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
      const named = Option.getOrUndefined(client)?.requestMetadata?.["claudecode/toolUseId"];
      const toolUseId = typeof named === "string" ? named : undefined;
      const items = yield* (yield* DisplayModeWrap)
        .latestShownItems(threadId, toolUseId)
        .pipe(Effect.mapError(orchestrationError));
      return { ...readTurn(items, toolUseId), named: toolUseId !== undefined };
    });

    // A call that does not name itself cannot tell a send still running from its own, so two such
    // sends in one response would both pass. The send it accepted counts for a few seconds instead,
    // while the provider has not yet stored it, and only until the user types again.
    const unnamedSends = new Map<
      ThreadId,
      { readonly typed: string | null; readonly until: number }
    >();

    return {
      [SEND_TO_USER_TOOL_NAME]: McpToolAccess.readsAsCaller(() =>
        Effect.gen(function* () {
          const { threadId, mode } = yield* callerThread;
          if (!mode.oneSendPerMessage) return SHOWN;
          return yield* Effect.gen(function* () {
            const turn = yield* readThreadTurn(threadId);
            const now = yield* Clock.currentTimeMillis;
            const typed = turn.typed?.id ?? null;
            const held = unnamedSends.get(threadId);
            const heldSend = !turn.named && held?.typed === typed && now < held.until;
            if (turn.sends > 0 || heldSend) {
              return yield* refusal(
                "invalid_request",
                [
                  "you already sent the user a message after their last one, and this thread allows one per message of theirs. To change it, call replace_send_to_user.",
                ],
                turn,
              );
            }
            if (!turn.named)
              unnamedSends.set(threadId, { typed, until: now + UNNAMED_SEND_HOLD_MS });
            return SHOWN;
          }).pipe(lockFor(threadId).withPermits(1));
        }),
      ),
      [REPLACE_SEND_TO_USER_TOOL_NAME]: McpToolAccess.readsAsCaller(({ user_message, old_text }) =>
        Effect.gen(function* () {
          const { threadId, mode } = yield* callerThread;
          return yield* Effect.gen(function* () {
            const turn = yield* readThreadTurn(threadId);
            if (!mode.oneSendPerMessage) {
              return yield* refusal(
                "capability_denied",
                [
                  "replace_send_to_user works only in threads set to Messages only or Messages + Dashboard. Use send_to_user.",
                ],
                turn,
              );
            }
            if (turn.current === undefined) {
              return yield* refusal(
                "invalid_request",
                [
                  "you have sent no message since the user's last one, so there is nothing to replace. Use send_to_user.",
                ],
                turn,
              );
            }
            const typed = turn.typed?.text ?? "";
            const userSimilarity = Math.max(
              textSimilarity(quoted(user_message), recapText(typed)),
              textSimilarity(quoted(user_message), providerForm(typed)),
            );
            const oldSimilarity = textSimilarity(quoted(old_text), recapText(turn.current.text));
            const mismatches = [
              ...(userSimilarity >= TEXT_MATCH_MIN_RATIO
                ? []
                : [
                    `user_message is ${percent(userSimilarity)}% like the user's last message; ${typed === "" ? "expected an empty string" : `needs ${MIN_PERCENT}%`}.`,
                  ]),
              ...(oldSimilarity >= TEXT_MATCH_MIN_RATIO
                ? []
                : [
                    `old_text is ${percent(oldSimilarity)}% like your current message; needs ${MIN_PERCENT}%.`,
                  ]),
            ];
            if (mismatches.length > 0) return yield* refusal("invalid_request", mismatches, turn);
            return SHOWN;
          }).pipe(lockFor(threadId).withPermits(1));
        }),
      ),
    };
  }),
);
