import { withoutAssistantCitationHash } from "~/lib/assistantCitationNavigation";
import type { ThreadRightPanelState } from "~/rightPanelStore";

import {
  asTabId,
  DEFAULT_LAYOUT,
  focusedTab,
  paneHolding,
  resolveLayout,
  type TabId,
  tabTraits,
  type WorkAreaLayout,
} from "./workArea.logic";

/** Scoped thread key and tab shown by a history entry, stored at `history.state.workAreaTab`. */
export type TabTag = { readonly thread: string; readonly tab: TabId };

declare module "@tanstack/react-router" {
  interface HistoryState {
    workAreaTab?: TabTag;
  }
}

/** Right-panel store fields read when checking whether a user changed the shown tab. */
export type PanelSnapshot = {
  readonly byThreadKey: Readonly<Record<string, ThreadRightPanelState>>;
  readonly userActionRevisionByThreadKey: Readonly<Record<string, number>>;
  readonly closeRevisionByThreadKey: Readonly<Record<string, number>>;
};

/** User action that changed the shown tab, either a switch from a prior tab or a close. */
export type TabChange =
  | { readonly type: "switch"; readonly from: TabId }
  | { readonly type: "close" };

/**
 * History writes for one tab change, with an optional replace to retag the current entry
 * and an optional push for the newly shown tab.
 */
export type TabWrite = {
  readonly retag: TabTag | null;
  readonly push: { readonly href: string; readonly tag: TabTag } | null;
};

/** Landed entry tag, with `sameOrigin` true when the move started on this same page. */
export type Move = {
  readonly tag: TabTag | null;
  readonly sameOrigin: boolean;
};

/**
 * Result of a Back or Forward landing. `none` defers to the router, `show` activates an
 * open tab, and `skip` steps once more past a closed or already shown tab.
 */
export type MoveDecision =
  | { readonly type: "none" }
  | { readonly type: "show"; readonly tab: TabId }
  | { readonly type: "skip" };

/** Returns a valid `TabTag` from untrusted history state, or `null` when absent or invalid. */
export function readTabTag(state: unknown): TabTag | null {
  if (typeof state !== "object" || state === null || !("workAreaTab" in state)) return null;
  const tag = state.workAreaTab;
  if (typeof tag !== "object" || tag === null || !("thread" in tag) || !("tab" in tag)) return null;
  return typeof tag.thread === "string" && typeof tag.tab === "string"
    ? { thread: tag.thread, tab: asTabId(tag.tab) }
    : null;
}

/**
 * Returns the thread's work-area layout, or the default single-Chat layout when the store
 * holds no record. The store drops a record when the layout is the default.
 */
export function layoutOf(
  byThreadKey: PanelSnapshot["byThreadKey"],
  thread: string,
): WorkAreaLayout {
  const record = byThreadKey[thread];
  return record ? resolveLayout(record) : DEFAULT_LAYOUT;
}

/**
 * Returns the user switch or close that changed the shown tab in `thread`, or `null`.
 * Only a strict rise of the user-action revision counts because thread removal deletes the
 * counters. With Find open, a switch between Chat, side chat, and reply tabs, the tabs that
 * hold a message box, is a Find step and returns `null`. Closes always count.
 */
export function userTabChange(
  prev: PanelSnapshot,
  next: PanelSnapshot,
  thread: string,
  findOpen: boolean,
): TabChange | null {
  // Strict increases only because removeThread deletes both revision keys.
  const rose = (key: "userActionRevisionByThreadKey" | "closeRevisionByThreadKey") =>
    (next[key][thread] ?? 0) > (prev[key][thread] ?? 0);
  if (!rose("userActionRevisionByThreadKey")) return null;
  const before = layoutOf(prev.byThreadKey, thread);
  const after = layoutOf(next.byThreadKey, thread);
  const from = focusedTab(before);
  const to = focusedTab(after);
  if (from === to) return null;
  if (rose("closeRevisionByThreadKey")) return { type: "close" };
  // Find steps move between tabs that hold a message box: Chat, side chat, and reply tabs.
  const findStep = findOpen && tabTraits(before, from).composer && tabTraits(after, to).composer;
  return findStep ? null : { type: "switch", from };
}

/**
 * Plans history writes for `change`, or `null` when none are needed, including when the
 * entry already holds `to`. A switch retags the current entry with the old tab unless the
 * entry already holds that tab, then pushes `to` at the href without the quote hash. A
 * close only retags the current entry with `to`. Quote entries are never retagged.
 */
export function planWrite(
  current: { readonly href: string; readonly tag: TabTag | null },
  thread: string,
  change: TabChange,
  to: TabId,
): TabWrite | null {
  const href = withoutAssistantCitationHash(current.href);
  // Back onto a quote entry replays its reveal, so a tag there would show one tab and then another.
  const tagged = (tab: TabId) => current.tag?.thread === thread && current.tag.tab === tab;
  const keeps = (tab: TabId) => href !== current.href || tagged(tab);
  if (change.type === "close") return keeps(to) ? null : { retag: { thread, tab: to }, push: null };
  if (change.from === to || tagged(to)) return null;
  return {
    retag: keeps(change.from) ? null : { thread, tab: change.from },
    push: { href, tag: { thread, tab: to } },
  };
}

/**
 * Decides how `thread` handles a Back or Forward landing. Skips a closed tab and shows an
 * open tab that is not shown. Skips the shown tab as a repeat stop only when the move started
 * on this thread's page, and otherwise stays.
 */
export function decideMove(
  move: Move,
  thread: string,
  byThreadKey: PanelSnapshot["byThreadKey"],
): MoveDecision {
  const { tag } = move;
  if (tag === null || tag.thread !== thread) return { type: "none" };
  const layout = layoutOf(byThreadKey, thread);
  if (paneHolding(layout.root, tag.tab) === undefined) return { type: "skip" };
  if (focusedTab(layout) !== tag.tab) return { type: "show", tab: tag.tab };
  // The shown tab is a repeat stop only when the move started on this thread's page.
  return move.sameOrigin ? { type: "skip" } : { type: "none" };
}
