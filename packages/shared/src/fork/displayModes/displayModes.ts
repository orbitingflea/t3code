import type {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

import { resolveT3McpToolId } from "../../t3McpToolPresentation.ts";
import { compactDynamicToolOutput } from "../../toolOutput.ts";

export const SEND_TO_USER_TOOL_NAME = "send_to_user";
/** A SQL LIKE pattern for the stored payload of a `send_to_user` call. */
export const SEND_TO_USER_PAYLOAD_LIKE = `%"toolName":"%${SEND_TO_USER_TOOL_NAME}"%`;
/** Keeps the call's input under the 16 KiB a tool input may take on the wire. */
export const SEND_TO_USER_MAX_BYTES = 12_000;
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
   * `events` may leave out events, as long as it keeps their order and the latest
   * WRAPPED_CORE_COUNT `user` and `sent` events.
   */
  readonly wrap: ((events: ReadonlyArray<DisplayEvent>, text: string) => string) | null;
  /** Whether the thread has a Dashboard that the user sees and the agent writes. */
  readonly dashboard: boolean;
}

const messagesOnlyCores = (events: ReadonlyArray<DisplayEvent>): VisibleCore[] =>
  events.flatMap((event): VisibleCore[] => {
    switch (event.type) {
      case "user":
        return [{ id: event.id, from: "user", text: event.text }];
      case "sent":
        return [{ id: event.id, from: "agent", text: event.text }];
      case "other":
        return [];
    }
  });

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
};

function messagesOnlyWrap(events: ReadonlyArray<DisplayEvent>, text: string): string {
  // Every message recaps the latest shown messages, so the agent always knows what the user saw,
  // whatever else entered its transcript. A message with nothing shown before it has no recap.
  const shown = messagesOnlyCores(events).slice(-WRAPPED_CORE_COUNT);
  if (shown.length === 0) return text;
  return [
    "<t3-messages-mode>",
    "This message is from the user. Before it, their screen showed:",
    ...shown.map(
      (core) =>
        `[${core.from === "user" ? "user" : "you"}] ${truncateUtf8(core.text, WRAPPED_CORE_MAX_BYTES)}`,
    ),
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
  visibleCores: messagesOnlyCores,
  wrap: messagesOnlyWrap,
  dashboard: false,
};

export const MESSAGES_DASHBOARD_DISPLAY_MODE: DisplayMode = {
  id: "messages-dashboard",
  label: "Messages + Dashboard",
  notice:
    "<t3-display-mode>The user switched this thread to Messages + Dashboard. They see only their own messages and your send_to_user messages; reply with send_to_user. They also see this thread's Dashboard, six slots in this order: decide (needs their decision), waiting, working, autoreview, humanreview, merged. Read it with dashboard_get. To change a slot, call dashboard_set with the slot's current text as old_text and the whole new text as new_text.</t3-display-mode>",
  stateNotice:
    "<t3-display-mode>This thread is in Messages + Dashboard. The user sees only their own messages and your send_to_user messages; reply with send_to_user. They also see this thread's Dashboard, six slots in this order: decide (needs their decision), waiting, working, autoreview, humanreview, merged. Read it with dashboard_get. To change a slot, call dashboard_set with the slot's current text as old_text and the whole new text as new_text.</t3-display-mode>",
  visibleCores: messagesOnlyCores,
  wrap: messagesOnlyWrap,
  dashboard: true,
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

/** A send that ended without reaching the user is `other`. A send that still runs shows nothing yet. */
function sendDisplayEvent(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>,
): DisplayEvent | null {
  // ACP providers report a refused MCP call as completed with an error result.
  const refused =
    item.status === "completed" && compactDynamicToolOutput(item.output)?.isError === true;
  if (refused || ENDED_UNSENT_STATUSES.has(item.status)) return { type: "other" };
  if (item.status !== "completed") return null;
  const input = item.input;
  return typeof input === "object" &&
    input !== null &&
    "text" in input &&
    typeof input.text === "string"
    ? { type: "sent", id: item.id, text: input.text }
    : null;
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
      return resolveT3McpToolId(item.toolName) === SEND_TO_USER_TOOL_NAME
        ? sendDisplayEvent(item)
        : { type: "other" };
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
 * Returns true if the mode's screen shows this item as text. The screen draws a completed
 * `send_to_user` call as a reply in every mode, and it draws other tools as work rows.
 */
export function displayModeShowsText(modeId: string, item: OrchestrationV2TurnItem): boolean {
  const event = displayEventFromTurnItem(item);
  if (item.type === "dynamic_tool" && event?.type !== "sent") return false;
  const { visibleCores } = resolveDisplayMode(modeId);
  return visibleCores === null || (event !== null && visibleCores([event]).length > 0);
}
