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
      if (item === undefined) return { type: "other" };
      const event = displayEventFromTurnItem(item);
      return event?.type === "sent" ? { ...event, id: entry.id } : event;
    }
    case "event":
      return displayEventFromTurnItem(entry.projectedItem.item);
    default:
      return { type: "other" };
  }
}

// Entries change on every streamed delta. A reply that keeps its object keeps its row from redrawing.
const repliesInRun = new WeakMap<TimelineEntry, TimelineEntry>();
const repliesOutsideRun = new WeakMap<TimelineEntry, TimelineEntry>();

/**
 * A sent message reads as the agent's reply, not as a tool call. The turn fold hides messages of a
 * run before its last one, so a mode that shows every send gives its replies no run.
 */
function replyEntry(entry: TimelineEntry, text: string, inRun: boolean): TimelineEntry {
  const replies = inRun ? repliesInRun : repliesOutsideRun;
  const known = replies.get(entry);
  if (known !== undefined) return known;
  const reply: TimelineEntry = {
    id: entry.id,
    kind: "message",
    createdAt: entry.createdAt,
    message: {
      id: MessageId.make(entry.id),
      role: "assistant",
      text,
      runId: inRun && entry.kind === "work" ? (entry.entry.structuredPayload?.runId ?? null) : null,
      streaming: false,
      createdBy: "agent",
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
    },
  };
  replies.set(entry, reply);
  return reply;
}

/**
 * Returns the rows that a display mode draws. A completed send is a reply in every mode, and a mode
 * without `visibleCores` keeps all rows. The result is `entries` itself when no row changes.
 */
export function applyDisplayMode(
  mode: DisplayMode,
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<TimelineEntry> {
  const events = entries.map(displayEventFromEntry);
  const shownIds =
    mode.visibleCores === null
      ? null
      : new Set(mode.visibleCores(events.filter((event) => event !== null)).map((core) => core.id));
  const rows = entries.flatMap((entry, index): TimelineEntry[] => {
    if (shownIds !== null && !shownIds.has(entry.id)) return [];
    const event = events[index];
    return [event?.type === "sent" ? replyEntry(entry, event.text, shownIds === null) : entry];
  });
  return rows.length === entries.length && rows.every((row, index) => row === entries[index])
    ? entries
    : rows;
}
