import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { deepEqual, type HistoryState, trimPathRight } from "@tanstack/react-router";

import { isThreadRoutePathname } from "~/threadRoutes";

import type { TabId } from "./workArea.logic";

/**
 * History-entry tag stored in `history.state.workAreaTab`.
 * Each write gets a unique `id` so the router never merges two entries as equal.
 */
export type TabTag = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tab: TabId;
  readonly id: string;
};

declare module "@tanstack/react-router" {
  interface HistoryState {
    workAreaTab?: TabTag;
  }
}

/** Reads a valid `TabTag` from a history state value, or returns `null` when missing or malformed. */
export function readTabTag(state: unknown): TabTag | null {
  if (typeof state !== "object" || state === null || !("workAreaTab" in state)) return null;
  const tag = state.workAreaTab;
  if (typeof tag !== "object" || tag === null) return null;
  const { environmentId, threadId, tab, id } = tag as Record<string, unknown>;
  if (
    typeof environmentId !== "string" ||
    typeof threadId !== "string" ||
    typeof tab !== "string" ||
    typeof id !== "string"
  ) {
    return null;
  }
  return {
    environmentId: environmentId as EnvironmentId,
    threadId: threadId as ThreadId,
    tab: tab as TabId,
    id,
  };
}

const ownedBy = (tag: TabTag, owner: ScopedThreadRef) =>
  tag.environmentId === owner.environmentId && tag.threadId === owner.threadId;

/** History writes for one user tab move, with an optional retag of the current entry before `push`. */
export type TabMove = { readonly retag: TabId | null; readonly push: TabId };

/**
 * Plans history writes for switching `owner` from `left` to `to`, or returns `null` if unchanged.
 * Retags the current entry with `left` unless `tag` already names that tab for `owner`.
 */
export function planMove(
  tag: TabTag | null,
  owner: ScopedThreadRef,
  left: TabId,
  to: TabId,
): TabMove | null {
  if (left === to) return null;
  const named = tag !== null && ownedBy(tag, owner) && tag.tab === left;
  return { retag: named ? null : left, push: to };
}

/** Maximum history entries skipped in one Back or Forward walk. */
export const MAX_WALK = 50;

/**
 * Facts about the history entry a pop landed on, used by `planLanding` to choose the next action.
 * `samePath` is `true` when the landing is on the page where the Back or Forward press started.
 */
export type LandingInput = {
  readonly last: "pop" | "write";
  readonly direction: -1 | 0 | 1;
  readonly moved: boolean;
  readonly tag: TabTag | null;
  readonly gonePath: boolean;
  readonly showable: boolean;
  readonly shown: TabId | null;
  readonly samePath: boolean;
  readonly atStart: boolean;
  readonly steps: number;
};

/** Result of `planLanding`: stay on the current screen, show a tagged tab, or step on by `delta`. */
export type Landing =
  | { readonly kind: "stay" }
  | { readonly kind: "show"; readonly tag: TabTag }
  | { readonly kind: "step"; readonly delta: -1 | 1 };

type LandingRow = readonly [
  when: (input: LandingInput, canStep: boolean) => boolean,
  then: Landing["kind"],
];

// First match wins; no match stays.
const LANDING_ROWS: readonly LandingRow[] = [
  [(input) => input.last === "write", "stay"],
  [(input) => !input.moved, "stay"],
  [(input, canStep) => input.gonePath && canStep, "step"],
  [(input) => input.tag === null, "stay"],
  // On another page than the press started on, the landing is a page change, as on base.
  [(input, canStep) => input.samePath && !input.showable && canStep, "step"],
  [(input, canStep) => input.samePath && input.tag?.tab === input.shown && canStep, "step"],
  [(input) => input.showable && input.tag?.tab !== input.shown, "show"],
];

/**
 * Chooses whether to stay, show the entry's tab, or keep stepping on Back or Forward.
 * Steps past deleted threads on any page, and past closed or repeated tabs only on `samePath`.
 * Never steps without a direction, past `MAX_WALK` steps, or back past the first entry.
 */
export function planLanding(input: LandingInput): Landing {
  const { direction, tag } = input;
  const canStep = direction !== 0 && input.steps < MAX_WALK && !(direction === -1 && input.atStart);
  const kind = LANDING_ROWS.find(([when]) => when(input, canStep))?.[1] ?? "stay";
  if (kind === "step" && direction !== 0) return { kind, delta: direction };
  if (kind === "show" && tag !== null) return { kind, tag };
  return { kind: "stay" };
}

// The router's own keys, which its same-state check ignores.
const ROUTER_KEYS = new Set(["key", "__TSR_key", "__TSR_index", "__hashScrollIntoViewOptions"]);
const appFields = (state: object) => Object.entries(state).filter(([key]) => !ROUTER_KEYS.has(key));

/**
 * Carries `current`'s `TabTag` onto an untagged `next` state, or returns `null`. Keeps the tag on
 * a `replace` to the tag owner's thread route. On the same URL, copies all current app state when
 * `narrow` and `next.state` has none, or carries the tag only when that keeps the same entry.
 */
export function carryTag<S extends HistoryState>(
  current: { readonly href: string; readonly state: HistoryState },
  next: {
    readonly href: string;
    readonly pathname: string;
    readonly state: S;
    readonly replace?: boolean | undefined;
  },
  narrow: boolean,
): S | null {
  const tag = readTabTag(current.state);
  if (tag === null || readTabTag(next.state) !== null) return null;
  const state = { ...next.state, workAreaTab: current.state.workAreaTab };
  if (trimPathRight(current.href) !== trimPathRight(next.href)) {
    // A redirect onto the owner's thread page, such as a sent draft's, keeps the entry's tab.
    return next.replace === true && isThreadRoutePathname(next.pathname, tag) ? state : null;
  }
  const own = Object.fromEntries(appFields(current.state));
  // With no state of its own, the navigation takes all of the entry's, so the router keeps it.
  if (narrow && appFields(next.state).length === 0) return { ...next.state, ...own };
  // Otherwise the tag goes along only to keep the same entry; a new entry starts untagged.
  return deepEqual(Object.fromEntries(appFields(state)), own) ? state : null;
}
