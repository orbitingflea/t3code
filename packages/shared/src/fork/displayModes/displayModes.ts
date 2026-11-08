import type {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

import { assistantCitationsToPlainText } from "../../assistantCitations.ts";
import { resolveT3McpToolId } from "../../t3McpToolPresentation.ts";
import { compactDynamicToolOutput } from "../../toolOutput.ts";

export const SEND_TO_USER_TOOL_NAME = "send_to_user";
export const REPLACE_SEND_TO_USER_TOOL_NAME = "replace_send_to_user";
/**
 * A SQL LIKE pattern for the stored payload of a `send_to_user` call. It ends the name with
 * `send_to_user`, so it also selects `replace_send_to_user` calls, which change a send's text.
 */
export const SEND_TO_USER_PAYLOAD_LIKE = `%"toolName":"%${SEND_TO_USER_TOOL_NAME}"%`;
/** One concise point per message: a longer send or rewrite is refused. */
export const SEND_TO_USER_MAX_BYTES = 1_000;
export const DASHBOARD_SET_TOOL_NAME = "dashboard_set";
export const DASHBOARD_GET_TOOL_NAME = "dashboard_get";

const WRAPPED_CORE_MAX_BYTES = 2_000;
/** How many of the latest shown messages a wrapped message lists. */
export const WRAPPED_CORE_COUNT = 3;

/**
 * A thread's history as a display mode sees it. Web timeline entries and
 * server turn items both map to this list, so the screen and the wrapper
 * agree on what the user saw.
 */
export type DisplayEvent =
  | { readonly type: "user"; readonly id: string; readonly text: string }
  | { readonly type: "sent"; readonly id: string; readonly text: string }
  /** A completed `replace_send_to_user` call. The latest `sent` before it now reads `text`. */
  | { readonly type: "rewrite"; readonly id: string; readonly text: string }
  /**
   * Anything else that entered the agent's transcript, such as its plain text, reasoning, tool work,
   * and messages the user did not type.
   */
  | { readonly type: "other" };

/** A core is one message that a display mode shows, from the user or from the agent. */
export interface VisibleCore {
  readonly id: string;
  readonly from: "user" | "agent";
  readonly text: string;
}

export interface DisplayMode {
  readonly id: string;
  readonly label: string;
  /**
   * Goes before the first message that the user types after the thread switches to this mode. A new
   * thread starts as Normal, so its first message in another mode gets that mode's note.
   */
  readonly notice: string;
  /** States the mode to an agent whose conversation was just compacted, which may have dropped `notice`. */
  readonly stateNotice: string;
  /** Null keeps the whole timeline. */
  readonly visibleCores: ((events: ReadonlyArray<DisplayEvent>) => VisibleCore[]) | null;
  /**
   * Returns the text that the agent gets for a user's message after `events`. Null sends it unchanged.
   * `events` may leave out events, as long as it keeps their order, the latest
   * WRAPPED_CORE_COUNT `user` and `sent` events, and every `rewrite` after the first of those.
   */
  readonly wrap: ((events: ReadonlyArray<DisplayEvent>, text: string) => string) | null;
  /** Whether the thread has a Dashboard that the user sees and the agent writes. */
  readonly dashboard: boolean;
  /**
   * Whether the agent may send one message after each message that the user types. To say more,
   * it rewrites that message with `replace_send_to_user`.
   */
  readonly oneSendPerMessage: boolean;
}

/**
 * The messages that `events` show, in order. Each `user` and `sent` event adds one; a `rewrite`
 * sets the text of the latest `sent` before it and adds none. A rewrite with no `sent` before it,
 * such as one whose send is on a history page not loaded yet, shows nothing.
 */
export function foldCores(events: Iterable<DisplayEvent>): VisibleCore[] {
  const cores: VisibleCore[] = [];
  let latestSent: number | undefined;
  for (const event of events) {
    switch (event.type) {
      case "user":
        cores.push({ id: event.id, from: "user", text: event.text });
        break;
      case "sent":
        latestSent = cores.push({ id: event.id, from: "agent", text: event.text }) - 1;
        break;
      case "rewrite":
        if (latestSent !== undefined)
          cores[latestSent] = { ...cores[latestSent]!, text: event.text };
        break;
      case "other":
        break;
    }
  }
  return cores;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let bytes = 0;
  let kept = "";
  for (const character of text) {
    bytes += encoder.encode(character).length;
    if (bytes > maxBytes) break;
    kept += character;
  }
  return `${kept}…[truncated]`;
}

/** A message as a recap shows it: each quote as its quoted text and comment, cut at 2000 bytes. */
export function recapText(text: string): string {
  return truncateUtf8(assistantCitationsToPlainText(text), WRAPPED_CORE_MAX_BYTES);
}

/** One line of a recap, such as `[you] Done.` */
export const recapLine = (core: VisibleCore): string =>
  `[${core.from === "user" ? "user" : "you"}] ${recapText(core.text)}`;

export const NORMAL_DISPLAY_MODE: DisplayMode = {
  id: "normal",
  label: "Normal",
  notice:
    "<t3-display-mode>The user switched this thread back to the full view. They see all your output again; reply in plain text.</t3-display-mode>",
  stateNotice:
    "<t3-display-mode>This thread is in the full view. The user sees all your output; reply in plain text.</t3-display-mode>",
  visibleCores: null,
  wrap: null,
  dashboard: false,
  oneSendPerMessage: false,
};

function messagesOnlyWrap(events: ReadonlyArray<DisplayEvent>, text: string): string {
  // Every message recaps the latest shown messages, so the agent always knows what the user saw,
  // whatever else entered its transcript. A message with nothing shown before it has no recap.
  const shown = foldCores(events).slice(-WRAPPED_CORE_COUNT);
  if (shown.length === 0) return text;
  return [
    "<t3-messages-mode>",
    "This message is from the user. Before it, their screen showed:",
    ...shown.map(recapLine),
    "</t3-messages-mode>",
    text,
  ].join("\n");
}

export const MESSAGES_ONLY_DISPLAY_MODE: DisplayMode = {
  id: "messages-only",
  label: "Messages only",
  notice:
    "<t3-display-mode>The user switched this thread to Messages only. From now on they see only their own messages and your send_to_user messages; reply with send_to_user.</t3-display-mode>",
  stateNotice:
    "<t3-display-mode>This thread is in Messages only. The user sees only their own messages and your send_to_user messages; reply with send_to_user.</t3-display-mode>",
  visibleCores: foldCores,
  wrap: messagesOnlyWrap,
  dashboard: false,
  oneSendPerMessage: true,
};

export const MESSAGES_DASHBOARD_DISPLAY_MODE: DisplayMode = {
  id: "messages-dashboard",
  label: "Messages + Dashboard",
  notice:
    "<t3-display-mode>The user switched this thread to Messages + Dashboard. They see only their own messages and your send_to_user messages; reply with send_to_user. They also see this thread's Dashboard, six slots in this order: decide (needs their decision), waiting, working, autoreview, humanreview, merged. Read it with dashboard_get. To change a slot, call dashboard_set with the slot's current text as old_text and the whole new text as new_text.</t3-display-mode>",
  stateNotice:
    "<t3-display-mode>This thread is in Messages + Dashboard. The user sees only their own messages and your send_to_user messages; reply with send_to_user. They also see this thread's Dashboard, six slots in this order: decide (needs their decision), waiting, working, autoreview, humanreview, merged. Read it with dashboard_get. To change a slot, call dashboard_set with the slot's current text as old_text and the whole new text as new_text.</t3-display-mode>",
  visibleCores: foldCores,
  wrap: messagesOnlyWrap,
  dashboard: true,
  oneSendPerMessage: true,
};

export const DISPLAY_MODES: ReadonlyArray<DisplayMode> = [
  NORMAL_DISPLAY_MODE,
  MESSAGES_ONLY_DISPLAY_MODE,
  MESSAGES_DASHBOARD_DISPLAY_MODE,
];

/** An unknown or removed mode id shows the thread as Normal. */
export function resolveDisplayMode(id: string | undefined): DisplayMode {
  return DISPLAY_MODES.find((mode) => mode.id === id) ?? NORMAL_DISPLAY_MODE;
}

const USER_TYPED_SOURCES: ReadonlySet<OrchestrationV2CreationSource> = new Set(["web", "mobile"]);

/** The fields of a message that say who or what made it. */
export interface MessageOrigin {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: unknown;
  readonly senderThreadId?: unknown;
  readonly idleCompaction?: unknown;
}

/**
 * Returns true for a message that the user typed in a client. Messages that the server makes for the
 * user, such as a retry after a usage limit, an approval reply, or an imported message, get false,
 * and so do messages from agents, providers, scheduled tasks, and T3 Code's own `/compact`.
 */
function isUserTypedMessage(message: MessageOrigin): boolean {
  return (
    message.createdBy === "user" &&
    USER_TYPED_SOURCES.has(message.creationSource) &&
    message.scheduledTaskId === undefined &&
    message.senderThreadId === undefined &&
    message.idleCompaction === undefined
  );
}

/**
 * Returns true for a message typed where display modes apply. Only the web app shows a mode, so the
 * agent is told about the user's screen only for these messages.
 */
export function isWebTypedMessage(message: MessageOrigin): boolean {
  return isUserTypedMessage(message) && message.creationSource === "web";
}

const ENDED_UNSENT_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "failed",
  "cancelled",
  "interrupted",
]);

/** The tools whose completed calls change what the user reads, and the input field with the text. */
const MESSAGE_TOOLS: Readonly<
  Record<string, { readonly type: "sent" | "rewrite"; readonly field: string }>
> = {
  [SEND_TO_USER_TOOL_NAME]: { type: "sent", field: "text" },
  [REPLACE_SEND_TO_USER_TOOL_NAME]: { type: "rewrite", field: "new_text" },
};

/** A call that ended without reaching the user is `other`. A call that still runs shows nothing yet. */
function messageToolEvent(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>,
  tool: (typeof MESSAGE_TOOLS)[string],
): DisplayEvent | null {
  // ACP providers report a refused MCP call as completed with an error result.
  const refused =
    item.status === "completed" && compactDynamicToolOutput(item.output)?.isError === true;
  if (refused || ENDED_UNSENT_STATUSES.has(item.status)) return { type: "other" };
  if (item.status !== "completed") return null;
  const input = item.input;
  const text =
    typeof input === "object" && input !== null ? Reflect.get(input, tool.field) : undefined;
  return typeof text === "string" ? { type: tool.type, id: item.id, text } : null;
}

/**
 * A user message without `createdBy` and `creationSource`, such as the web's local copy of a message
 * that is still sending, counts as typed by the user. Blank text from any other role shows nothing.
 */
export function displayEventFromMessage(
  message: Omit<MessageOrigin, "createdBy" | "creationSource"> & {
    readonly id: string;
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly createdBy?: MessageOrigin["createdBy"] | undefined;
    readonly creationSource?: MessageOrigin["creationSource"] | undefined;
  },
): DisplayEvent | null {
  if (message.role !== "user") return message.text.trim() === "" ? null : { type: "other" };
  return isUserTypedMessage({
    ...message,
    createdBy: message.createdBy ?? "user",
    creationSource: message.creationSource ?? "web",
  })
    ? { type: "user", id: message.id, text: message.text }
    : { type: "other" };
}

/** Item types that the app records but never puts in the agent's transcript. */
const OUTSIDE_TRANSCRIPT_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "checkpoint",
  "fork",
  "thread_created",
  "run_interrupt_request",
  "run_interrupt_result",
  "system_notice",
  "error",
]);

/** Items that never enter the agent's transcript, such as checkpoints and system notices, map to null. */
export function displayEventFromTurnItem(item: OrchestrationV2TurnItem): DisplayEvent | null {
  switch (item.type) {
    case "user_message":
      // A queued message that has not started is not in the agent's transcript or on the screen.
      return item.inputIntent === "queued_turn" && item.status === "pending"
        ? null
        : displayEventFromMessage({ ...item, id: item.messageId, role: "user" });
    case "assistant_message":
      return displayEventFromMessage({ id: item.messageId, role: "assistant", text: item.text });
    case "dynamic_tool": {
      const tool = MESSAGE_TOOLS[resolveT3McpToolId(item.toolName) ?? ""];
      return tool === undefined ? { type: "other" } : messageToolEvent(item, tool);
    }
    default:
      return OUTSIDE_TRANSCRIPT_TYPES.has(item.type) ? null : { type: "other" };
  }
}

/** The text of a completed `send_to_user` call. Any other item has none. */
export function sentMessageText(item: OrchestrationV2TurnItem): string | null {
  const event = displayEventFromTurnItem(item);
  return event?.type === "sent" ? event.text : null;
}

/**
 * Each completed send in `items`, by item id, with the text that the latest rewrite gave it. Only
 * tool calls decide that, so it reads no message text. With `unmatchedRewrite`, the latest rewrite
 * before the first send, whose send lies before `items`, such as a handoff's delta, is kept by its
 * own id.
 */
export function foldSentTexts(
  items: Iterable<OrchestrationV2TurnItem>,
  options: { readonly unmatchedRewrite?: boolean } = {},
): Map<string, string> {
  const events = Array.from(items)
    .filter((item) => item.type === "dynamic_tool")
    .map(displayEventFromTurnItem)
    .filter((event) => event !== null);
  const texts = new Map(
    foldCores(events).flatMap((core): [string, string][] =>
      core.from === "agent" ? [[core.id, core.text]] : [],
    ),
  );
  const firstSent = events.findIndex((event) => event.type === "sent");
  const unmatched = (firstSent < 0 ? events : events.slice(0, firstSent)).findLast(
    (event) => event.type === "rewrite",
  );
  if (options.unmatchedRewrite && unmatched !== undefined) texts.set(unmatched.id, unmatched.text);
  return texts;
}

/** Returns true for a `replace_send_to_user` call in any state. No screen draws one. */
export function isReplaceSendCall(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "dynamic_tool" &&
    resolveT3McpToolId(item.toolName) === REPLACE_SEND_TO_USER_TOOL_NAME
  );
}

/**
 * Returns true if the mode's screen shows this item as text. The screen draws a completed
 * `send_to_user` call as a reply in every mode, and it draws other tools as work rows.
 */
export function displayModeShowsText(modeId: string, item: OrchestrationV2TurnItem): boolean {
  const event = displayEventFromTurnItem(item);
  if (item.type === "dynamic_tool" && event?.type !== "sent") return false;
  const { visibleCores } = resolveDisplayMode(modeId);
  return visibleCores === null || (event !== null && visibleCores([event]).length > 0);
}
