import type { OrchestrationV2Actor, OrchestrationV2TurnItem } from "@t3tools/contracts";

import { resolveT3McpToolId } from "../../t3McpToolPresentation.ts";
import { compactDynamicToolOutput } from "../../toolOutput.ts";

export const SEND_TO_USER_TOOL_NAME = "send_to_user";
/** Keeps the call's input under the 16 KiB a tool input may take on the wire. */
export const SEND_TO_USER_MAX_BYTES = 12_000;

const WRAPPED_CORE_MAX_BYTES = 2_000;
const WRAPPED_CORE_COUNT = 3;

/**
 * A thread's history as a display mode sees it. Web timeline entries and
 * server turn items both map to this list, so the screen and the wrapper
 * agree on what the person saw.
 */
export type DisplayEvent =
  | { readonly type: "user"; readonly id: string; readonly text: string }
  | { readonly type: "sent"; readonly id: string; readonly text: string }
  /**
   * Stands for the agent's plain text. Messages only hides it. It does not count as hidden work,
   * because the agent knows what it wrote.
   */
  | { readonly type: "text" }
  | { readonly type: "work" };

/** A core is one message that a display mode shows, from the person or from the agent. */
export interface VisibleCore {
  readonly id: string;
  readonly from: "user" | "agent";
  readonly text: string;
}

export interface DisplayMode {
  readonly id: string;
  readonly label: string;
  /** Null keeps the whole timeline. */
  readonly visibleCores: ((events: ReadonlyArray<DisplayEvent>) => VisibleCore[]) | null;
  /** Returns the text that the agent gets for a person's message after `events`. Null sends it unchanged. */
  readonly wrap: ((events: ReadonlyArray<DisplayEvent>, text: string) => string) | null;
}

const messagesOnlyCores = (events: ReadonlyArray<DisplayEvent>): VisibleCore[] =>
  events.flatMap((event): VisibleCore[] => {
    switch (event.type) {
      case "user":
        return [{ id: event.id, from: "user", text: event.text }];
      case "sent":
        return [{ id: event.id, from: "agent", text: event.text }];
      case "text":
      case "work":
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
  visibleCores: null,
  wrap: null,
};

export const MESSAGES_ONLY_DISPLAY_MODE: DisplayMode = {
  id: "messages-only",
  label: "Messages only",
  visibleCores: messagesOnlyCores,
  wrap: (events, text) => {
    // A direct reply gets no wrapper. A message is a direct reply when nothing but the person's messages
    // and the agent's plain text came after the agent's last sent message. If the agent sent none, the
    // check starts at the beginning of the thread.
    const lastOther = events.findLast((event) => event.type !== "user" && event.type !== "text");
    if (lastOther === undefined || lastOther.type === "sent") return text;
    const shown = messagesOnlyCores(events).slice(-WRAPPED_CORE_COUNT);
    return [
      "<t3-messages-mode>",
      "This message is from the user. Other things happened in this thread since your last message to them, or since the thread began if you sent none. The user's screen showed:",
      ...shown.map(
        (core) =>
          `[${core.from === "user" ? "user" : "you"}] ${truncateUtf8(core.text, WRAPPED_CORE_MAX_BYTES)}`,
      ),
      "</t3-messages-mode>",
      text,
    ].join("\n");
  },
};

export const DISPLAY_MODES: ReadonlyArray<DisplayMode> = [
  NORMAL_DISPLAY_MODE,
  MESSAGES_ONLY_DISPLAY_MODE,
];

/** An unknown or removed mode id shows the thread as Normal. */
export function resolveDisplayMode(id: string | undefined): DisplayMode {
  return DISPLAY_MODES.find((mode) => mode.id === id) ?? NORMAL_DISPLAY_MODE;
}

/** Returns true for a message that the person typed. Messages from agents, the server, and scheduled prompts get false. */
export function isPersonMessage(message: {
  readonly createdBy: OrchestrationV2Actor;
  readonly scheduledTaskId?: unknown;
  readonly senderThreadId?: unknown;
}): boolean {
  return (
    message.createdBy === "user" &&
    message.scheduledTaskId === undefined &&
    message.senderThreadId === undefined
  );
}

const ENDED_UNSENT_STATUSES: ReadonlySet<OrchestrationV2TurnItem["status"]> = new Set([
  "failed",
  "cancelled",
  "interrupted",
]);

/** A send that ended without reaching the person counts as work. A send that still runs shows nothing yet. */
function sendDisplayEvent(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>,
): DisplayEvent | null {
  // ACP providers report a refused MCP call as completed with an error result.
  const refused =
    item.status === "completed" && compactDynamicToolOutput(item.output)?.isError === true;
  if (refused || ENDED_UNSENT_STATUSES.has(item.status)) return { type: "work" };
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
 * A user message without `createdBy` counts as the person's, unless it has a scheduled task or a sender
 * thread. Blank text from any other role shows nothing.
 */
export function displayEventFromMessage(message: {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor | undefined;
  readonly scheduledTaskId?: unknown;
  readonly senderThreadId?: unknown;
}): DisplayEvent | null {
  if (message.role !== "user") return message.text.trim() === "" ? null : { type: "text" };
  return isPersonMessage({ ...message, createdBy: message.createdBy ?? "user" })
    ? { type: "user", id: message.id, text: message.text }
    : { type: "work" };
}

const WORK_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "subagent",
  "todo_list",
  "proposed_plan",
]);

/** Items that are neither a message nor the agent's work, such as checkpoints and system notices, map to null. */
export function displayEventFromTurnItem(item: OrchestrationV2TurnItem): DisplayEvent | null {
  switch (item.type) {
    case "user_message":
      return displayEventFromMessage({ ...item, id: item.messageId, role: "user" });
    case "assistant_message":
      return displayEventFromMessage({ id: item.messageId, role: "assistant", text: item.text });
    case "dynamic_tool": {
      return resolveT3McpToolId(item.toolName) === SEND_TO_USER_TOOL_NAME
        ? sendDisplayEvent(item)
        : { type: "work" };
    }
    default:
      return WORK_ITEM_TYPES.has(item.type) ? { type: "work" } : null;
  }
}
