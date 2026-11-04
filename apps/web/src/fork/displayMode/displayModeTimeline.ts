import { MessageId } from "@t3tools/contracts";
import {
  type DisplayEvent,
  type DisplayMode,
  displayEventFromMessage,
  displayEventFromTurnItem,
} from "@t3tools/shared/displayModes";

import type { TimelineEntry } from "../../session-logic";

/** Each event id is its timeline entry's id, so each shown message leads back to its row. */
function displayEventFromEntry(entry: TimelineEntry): DisplayEvent | null {
  switch (entry.kind) {
    case "message":
      return displayEventFromMessage({ ...entry.message, id: entry.id });
    case "work": {
      const item = entry.entry.structuredPayload;
      if (item === undefined) return { type: "work" };
      const event = displayEventFromTurnItem(item);
      return event?.type === "sent" ? { ...event, id: entry.id } : event;
    }
    case "event":
      return displayEventFromTurnItem(entry.projectedItem.item);
    default:
      return { type: "work" };
  }
}

/** Returns the rows that a display mode shows. A mode without `visibleCores` keeps every row. */
export function applyDisplayMode(
  mode: DisplayMode,
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<TimelineEntry> {
  if (mode.visibleCores === null) return entries;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const events = entries.flatMap((entry) => {
    const event = displayEventFromEntry(entry);
    return event === null ? [] : [event];
  });
  return mode.visibleCores(events).flatMap((core): TimelineEntry[] => {
    const entry = byId.get(core.id);
    if (entry === undefined) return [];
    if (core.from === "user") return [entry];
    // A sent message reads as the agent's reply, not as a tool call.
    return [
      {
        id: entry.id,
        kind: "message",
        createdAt: entry.createdAt,
        message: {
          id: MessageId.make(entry.id),
          role: "assistant",
          text: core.text,
          runId: entry.kind === "work" ? (entry.entry.structuredPayload?.runId ?? null) : null,
          streaming: false,
          createdBy: "agent",
          createdAt: entry.createdAt,
          updatedAt: entry.createdAt,
        },
      },
    ];
  });
}
