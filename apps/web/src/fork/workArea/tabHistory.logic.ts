import type { ThreadRightPanelState } from "~/rightPanelStore";

import {
  asTabId,
  DEFAULT_LAYOUT,
  focusedTab,
  paneHolding,
  resolveLayout,
  type TabId,
  type WorkAreaLayout,
} from "./workArea.logic";

/**
 * Thread and tab recorded for a router history entry by its entry key. Marks `pushed` on entries
 * this code pushed and `dead` on entries of a deleted thread.
 */
export type TabEntry = {
  readonly thread: string;
  readonly tab: TabId;
  readonly pushed?: true;
  readonly dead?: true;
};

/** Parses a valid `TabEntry` from an untrusted stored value, or returns `null`. */
export function readTabEntry(value: unknown): TabEntry | null {
  if (typeof value !== "object" || value === null || !("thread" in value) || !("tab" in value)) {
    return null;
  }
  const pushed = "pushed" in value ? value.pushed : undefined;
  const dead = "dead" in value ? value.dead : undefined;
  if (
    typeof value.thread !== "string" ||
    typeof value.tab !== "string" ||
    (pushed !== undefined && pushed !== true) ||
    (dead !== undefined && dead !== true)
  ) {
    return null;
  }
  return {
    thread: value.thread,
    tab: asTabId(value.tab),
    ...(pushed ? { pushed } : {}),
    ...(dead ? { dead } : {}),
  };
}

/** Returns the resolved work-area layout for `thread`, or `DEFAULT_LAYOUT` when absent. */
export function layoutOf(
  byThreadKey: Readonly<Record<string, ThreadRightPanelState>>,
  thread: string,
): WorkAreaLayout {
  const record = byThreadKey[thread];
  return record ? resolveLayout(record) : DEFAULT_LAYOUT;
}

/** Snapshot of right-panel state and per-thread user-action and close revision counters. */
export type PanelRevisions = {
  readonly byThreadKey: Readonly<Record<string, ThreadRightPanelState>>;
  readonly userActionRevisionByThreadKey: Readonly<Record<string, number>>;
  readonly closeRevisionByThreadKey: Readonly<Record<string, number>>;
};

/** Shown tab before and after a user-driven tab change in one thread. */
export type TabChange = { readonly from: TabId; readonly to: TabId };

/**
 * Returns `{ from, to }` for a user-driven tab open or switch in `thread`, or `null` for closes,
 * thread removals, non-user updates, or updates that keep the same shown tab.
 */
export function userShownTabChange(
  prev: PanelRevisions,
  next: PanelRevisions,
  thread: string,
): TabChange | null {
  if (
    prev.byThreadKey[thread] === next.byThreadKey[thread] ||
    // Only a raised count is a user action; a deleted thread loses its count.
    (next.userActionRevisionByThreadKey[thread] ?? 0) <=
      (prev.userActionRevisionByThreadKey[thread] ?? 0) ||
    prev.closeRevisionByThreadKey[thread] !== next.closeRevisionByThreadKey[thread]
  ) {
    return null;
  }
  const from = focusedTab(layoutOf(prev.byThreadKey, thread));
  const to = focusedTab(layoutOf(next.byThreadKey, thread));
  return from === to ? null : { from, to };
}

/**
 * Current history entry's stored `tag` and whether the pending change is a quote entry's own
 * reveal.
 */
export type CurrentEntry = { readonly tag: TabEntry | null; readonly reveal: boolean };

/** Planned tag and history writes to push a new entry or retag the current entry. */
export type TabWrite =
  | { readonly type: "push"; readonly retag: TabEntry | null; readonly push: TabEntry }
  | { readonly type: "retag"; readonly retag: TabEntry };

/**
 * Plans tag and history writes for moving from `from` to `to` in `thread`, or returns `null`
 * when they match. A `current.reveal` move retags the current entry only. Any other move retags
 * it to `from` if needed and pushes a `pushed` entry for `to`.
 */
export function planPush(
  current: CurrentEntry,
  thread: string,
  { from, to }: TabChange,
): TabWrite | null {
  if (from === to) return null;
  const { tag } = current;
  // A retag keeps the mark of an entry this code pushed.
  const retagged = (tab: TabId): TabEntry =>
    tag?.thread === thread && tag.pushed ? { thread, tab, pushed: true } : { thread, tab };
  // A quote entry owns its own reveal; every other change gets an entry of its own.
  if (current.reveal) return { type: "retag", retag: retagged(to) };
  const retag = tag?.thread === thread && tag.tab === from ? null : retagged(from);
  return { type: "push", retag, push: { thread, tab: to, pushed: true } };
}

/** Target entry tag and URL comparison flags for a narrow-mode Back or Forward step. */
export type Move = {
  readonly entry: TabEntry | null;
  readonly samePath: boolean;
  readonly sameHref: boolean;
  readonly moved: boolean;
};

/** Thread key and resolved work-area layout currently shown in narrow mode. */
export type Shown = {
  readonly thread: string;
  readonly layout: WorkAreaLayout;
};

/** Action for a narrow-mode Back or Forward step to show a tab, skip the entry, or do nothing. */
export type MoveDecision =
  | { readonly type: "none" }
  | { readonly type: "show"; readonly tab: TabId }
  | { readonly type: "skip" };

/**
 * Decides what narrow-mode Back or Forward should do for `move`. Returns `show` for another open
 * tab of `shown.thread`, `skip` for a closed or already-shown tab at the same URL, and `none`
 * for dead entries, different URLs, or other moves.
 */
export function decideMove(move: Move, shown: Shown): MoveDecision {
  const { entry } = move;
  // Deleted threads' entries are skipped once per history, outside any thread's watcher.
  if (!move.moved || entry?.dead) return { type: "none" };
  if (entry === null || entry.thread !== shown.thread || !move.samePath) return { type: "none" };
  if (paneHolding(shown.layout.root, entry.tab) && focusedTab(shown.layout) !== entry.tab) {
    return { type: "show", tab: entry.tab };
  }
  // An entry whose URL differs, such as a quote link's, shows its own change.
  return move.sameHref ? { type: "skip" } : { type: "none" };
}

/** Back or Forward move inspected by the per-history listener, including the chain origin tag. */
export type HistoryMove = Pick<Move, "entry" | "samePath" | "moved"> & {
  // The tag of the entry the user's Back started from, until that Back passes a base.
  readonly origin: TabEntry | null;
};

/** Skip result from `decideHistoryMove`, distinguishing normal skips from a wide base skip. */
export type HistorySkip = "none" | "skip" | "skip-base";

/**
 * Decides whether the per-history listener should skip `move`. Returns `"skip"` for a dead entry
 * in either mode or a `pushed` entry in wide mode, `"skip-base"` in wide mode for the base entry
 * of a Back started on a `pushed` entry, and `"none"` otherwise.
 */
export function decideHistoryMove(move: HistoryMove, wide: boolean): HistorySkip {
  const { entry, origin } = move;
  if (!move.moved) return "none";
  if (entry?.dead) return "skip";
  if (!wide) return "none";
  // Wide windows step as if the pushed entries were not there.
  if (entry?.pushed) return "skip";
  // A Back that started inside a run of pushed entries logically started at that run's base.
  const base =
    origin?.pushed === true && move.samePath && (entry === null || entry.thread === origin.thread);
  return base ? "skip-base" : "none";
}

// A Back or Forward between two entries of one thread, as our restores and skips are.
/**
 * Returns `true` when `move` stepped along the same pathname between two entries of `left`'s
 * thread.
 */
export const isTabStep = (
  move: Pick<Move, "entry" | "samePath" | "moved">,
  left: TabEntry | null,
) => move.moved && move.samePath && move.entry !== null && move.entry.thread === left?.thread;
