import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { SEND_TO_USER_MAX_BYTES, SEND_TO_USER_TOOL_NAME } from "@t3tools/shared/displayModes";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";

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

// The tool changes only what the caller's thread shows, so read-only sandboxes and plan mode may use it.
const SendToUserTool = Tool.make(SEND_TO_USER_TOOL_NAME, {
  description:
    "Show the user a message in this thread. In a thread set to Messages only, this is the only output the user sees.",
  parameters: Schema.Struct({ text: MessageText }),
  success: Schema.Struct({ ok: Schema.Literal(true), message: Schema.String }),
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Send to user")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const SendToUserToolkit = Toolkit.make(SendToUserTool);

// The thread keeps the completed call like any tool call, and that call is the message.
export const layerHandlers = McpToolAccess.toLayer(SendToUserToolkit, {
  [SEND_TO_USER_TOOL_NAME]: McpToolAccess.readsAsCaller(() =>
    Effect.succeed({
      ok: true as const,
      message: "Shown to the user. If you are done, end your turn with no text.",
    }),
  ),
});
