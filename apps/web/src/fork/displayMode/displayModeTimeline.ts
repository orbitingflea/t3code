import { MessageId } from "@t3tools/contracts";
import {
  type DisplayEvent,
  type DisplayMode,
  displayEventFromMessage,
  displayEventFromTurnItem,
  foldCores,
  isReplaceSendCall,
  type VisibleCore,
} from "@t3tools/shared/displayModes";

import type { MessagesTimelineRow } from "../../components/chat/MessagesTimeline.logic";
import type { TimelineEntry } from "../../session-logic";
import type { SubThreadSummaries, SubThreadSummary } from "../subThreads/subThreadsState";

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

// Entries change on every streamed delta. A reply that keeps its object keeps its row from redrawing,
// until a rewrite changes its text without changing its entry.
const repliesInRun = new WeakMap<TimelineEntry, Extract<TimelineEntry, { kind: "message" }>>();
const repliesOutsideRun = new WeakMap<TimelineEntry, Extract<TimelineEntry, { kind: "message" }>>();

/**
 * A sent message reads as the agent's reply, not as a tool call. The turn fold hides messages of a
 * run before its last one, so a mode that shows every send gives its replies no run.
 */
function replyEntry(entry: TimelineEntry, text: string, inRun: boolean): TimelineEntry {
  const replies = inRun ? repliesInRun : repliesOutsideRun;
  const known = replies.get(entry);
  if (known?.message.text === text) return known;
  const reply: Extract<TimelineEntry, { kind: "message" }> = {
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

interface FoldedTimeline {
  readonly events: ReadonlyArray<DisplayEvent | null>;
  readonly shown: ReadonlyArray<DisplayEvent>;
  readonly cores: ReadonlyArray<VisibleCore>;
}

// The rows and the sub-thread summaries of one timeline come from the same fold.
const foldedTimelines = new WeakMap<ReadonlyArray<TimelineEntry>, FoldedTimeline>();

function foldTimeline(entries: ReadonlyArray<TimelineEntry>): FoldedTimeline {
  let folded = foldedTimelines.get(entries);
  if (folded === undefined) {
    const events = entries.map(displayEventFromEntry);
    const shown = events.filter((event) => event !== null);
    folded = { events, shown, cores: foldCores(shown) };
    foldedTimelines.set(entries, folded);
  }
  return folded;
}

const summariesOfTimeline = new WeakMap<ReadonlyArray<TimelineEntry>, SubThreadSummaries>();

const sameSummary = (a: SubThreadSummary, b: SubThreadSummary) =>
  a.replies === b.replies &&
  a.lastAt === b.lastAt &&
  a.lastFrom === b.lastFrom &&
  a.lastText === b.lastText &&
  a.firstText === b.firstText &&
  a.agentReplyTimes.length === b.agentReplyTimes.length;

/**
 * Each sub-thread that the loaded entries show, by the id of its first message, which must be
 * loaded too. A summary that equals its `previous` one is that object, and the result is
 * `previous` itself when nothing changed, so a streamed delta redraws no reply line.
 */
export function timelineSubThreads(
  entries: ReadonlyArray<TimelineEntry>,
  previous: SubThreadSummaries | null,
): SubThreadSummaries {
  const known = summariesOfTimeline.get(entries);
  if (known !== undefined) return known;
  const createdAt = new Map(entries.map((entry) => [entry.id, entry.createdAt]));
  const summaries = new Map<string, SubThreadSummary>();
  for (const core of foldTimeline(entries).cores) {
    const at = createdAt.get(core.id) ?? "";
    if (!core.reply) {
      summaries.set(core.id, {
        first: core.id,
        firstFrom: core.from,
        firstText: core.text,
        replies: 0,
        lastAt: at,
        lastFrom: core.from,
        lastText: core.text,
        agentReplyTimes: [],
      });
      continue;
    }
    const summary = core.first === null ? undefined : summaries.get(core.first);
    if (summary === undefined) continue;
    summaries.set(summary.first, {
      ...summary,
      replies: summary.replies + 1,
      lastAt: at,
      lastFrom: core.from,
      lastText: core.text,
      agentReplyTimes:
        core.from === "agent" ? [...summary.agentReplyTimes, at] : summary.agentReplyTimes,
    });
  }
  let changed = previous === null || previous.size !== summaries.size;
  for (const [first, summary] of summaries) {
    const before = previous?.get(first);
    if (before !== undefined && sameSummary(before, summary)) summaries.set(first, before);
    else changed = true;
  }
  const result = changed || previous === null ? summaries : previous;
  summariesOfTimeline.set(entries, result);
  return result;
}

/** The shown message of the row `id`, an entry id or a message id. Undefined when none is loaded. */
function coreOfRow(entries: ReadonlyArray<TimelineEntry>, id: string): VisibleCore | undefined {
  const entry = entries.find(
    (candidate) =>
      candidate.id === id || (candidate.kind === "message" && candidate.message.id === id),
  );
  return entry && foldTimeline(entries).cores.find((candidate) => candidate.id === entry.id);
}

/**
 * The first message of the sub-thread that holds the reply `id`. Null when `id` is not a loaded
 * reply: a first message, a row of no sub-thread, or no row.
 */
export function subThreadOfReply(entries: ReadonlyArray<TimelineEntry>, id: string): string | null {
  const core = coreOfRow(entries, id);
  return core?.reply === true ? core.first : null;
}

/**
 * Whether the row `id` shows in one view of a thread with sub-threads: the main list when
 * `subThread` is null, else the sub-thread of that first message. `elsewhere` is a loaded message
 * that only another view shows; `unknown` is a row that is not loaded, or is no message.
 */
export function rowShownIn(
  entries: ReadonlyArray<TimelineEntry>,
  id: string,
  subThread: string | null,
): "here" | "elsewhere" | "unknown" {
  const core = coreOfRow(entries, id);
  if (core === undefined) return "unknown";
  if (subThread === null) return core.reply ? "elsewhere" : "here";
  return core.first === subThread ? "here" : "elsewhere";
}

/**
 * Returns the rows that a display mode draws. A completed send is a reply in every mode, with the
 * text of its latest rewrite, and a replace call has no row. A mode without `visibleCores` keeps
 * all other rows. A mode with sub-threads draws the first messages, or with `subThread`, the id of
 * a first message, that message and its replies. The result is `entries` itself when no row changes.
 */
export function applyDisplayMode(
  mode: DisplayMode,
  entries: ReadonlyArray<TimelineEntry>,
  subThread: string | null = null,
): ReadonlyArray<TimelineEntry> {
  const { events, shown, cores } = foldTimeline(entries);
  const coreTexts = new Map(cores.map((core) => [core.id, core.text]));
  const shownIds = mode.subThreads
    ? new Set(
        cores
          .filter((core) => (subThread === null ? !core.reply : core.first === subThread))
          .map((core) => core.id),
      )
    : mode.visibleCores === null
      ? null
      : new Set(mode.visibleCores(shown).map((core) => core.id));
  const rows = entries.flatMap((entry, index): TimelineEntry[] => {
    if (shownIds !== null && !shownIds.has(entry.id)) return [];
    const item = entry.kind === "work" ? entry.entry.structuredPayload : undefined;
    if (item !== undefined && isReplaceSendCall(item)) return [];
    const event = events[index];
    return [
      event?.type === "sent"
        ? replyEntry(entry, coreTexts.get(entry.id) ?? event.text, shownIds === null)
        : entry,
    ];
  });
  return rows.length === entries.length && rows.every((row, index) => row === entries[index])
    ? entries
    : rows;
}

/** A mode that chooses its replies draws no Working or Thinking row. */
export function displayModeRows(
  rows: MessagesTimelineRow[],
  repliesChosen: boolean,
): MessagesTimelineRow[] {
  return repliesChosen
    ? rows.filter((row) => row.kind !== "working" && row.kind !== "thinking")
    : rows;
}
