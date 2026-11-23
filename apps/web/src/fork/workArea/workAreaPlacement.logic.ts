import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelKind, RightPanelSurface, ThreadRightPanelState } from "~/rightPanelStore";
import type { ChatFileAttachment } from "~/types";

import {
  type ArmKind,
  asTabId,
  chatTabs,
  DEFAULT_LAYOUT,
  defaultLayout,
  type Edge,
  findPane,
  focusAfterRemoval,
  insertTabs,
  isDefaultLayout,
  isNonEmpty,
  LAUNCHER,
  type LayoutNode,
  leaves,
  linkedFileEntry,
  type LinkedFileEntry,
  linkedFileTabId,
  mapPanes,
  mapSplits,
  nearestRemaining,
  PANE_ID,
  type PaneId,
  type PaneNode,
  paneHolding,
  PRIMARY_CHAT,
  PRIMARY_PAYLOAD,
  removeTabs,
  replyTabId,
  resolveLayout,
  secondaryChatTabId,
  setPane,
  shownLinkedFile,
  SPLIT_ID,
  type SplitId,
  splitPane,
  surfaceTabId,
  type TabId,
  tabTraits,
  traitsOf,
  type WorkAreaLayout,
  type WorkAreaTab,
  withoutArmed,
  withPayload,
  withRevealed,
  workspaceEntryPath,
} from "./workArea.logic";
import {
  clampRatio,
  fittedRatio,
  fitsView,
  isStripView,
  paneRects,
  type Rect,
  settleAround,
  settleSplit,
  tabShown,
  type WorkAreaView,
} from "./workAreaGeometry.logic";
import {
  floatedByClose,
  floatTab,
  keptFloat,
  unfloatTab,
  withoutFloating,
} from "./workAreaFloat.logic";

/** Origin of a store write: "activate" is a tab press; "reveal" is an agent's forced show. */
export type LayoutWriteKind = "user" | "close" | "automatic" | "activate" | "reveal";

/**
 * Where an open started. A `tab` with `adjacent` lands right after it in its pane. An `armed` +
 * menu pick holds while its pane exists, even after `layout.armed` clears. An origin without `tab`
 * or `armed` uses normal placement. A live `drop` (a dropped link's place) wins. User writes place
 * tabs outside `existing` (surface tabs at start) by this origin even if another write placed them.
 */
export type OpenFrom = (
  | { readonly tab: TabId; readonly adjacent?: true; readonly armed?: never }
  | {
      readonly armed: NonNullable<WorkAreaLayout["armed"]>;
      readonly tab?: never;
      readonly adjacent?: never;
    }
  | { readonly tab?: never; readonly adjacent?: never; readonly armed?: never }
) & { readonly existing?: ReadonlySet<TabId>; readonly drop?: LinkDrop };

// A dropped link's open lands at `at` while `live`; else the origin under it applies.
export interface LinkDrop {
  readonly at: Placement;
  readonly live: () => boolean;
}

export type Placement =
  | { readonly kind: "strip"; readonly pane: PaneId; readonly before: TabId | null }
  | { readonly kind: "edge"; readonly pane: PaneId; readonly edge: Edge }
  | { readonly kind: "join"; readonly pane: PaneId };

export type PlaceSource =
  | { readonly tabs: readonly TabId[] }
  | { readonly threads: readonly ScopedThreadRef[] };

/** The work area's own gestures. Ids, never indices: a stale change is a no-op. */
export type WorkAreaChange =
  | {
      readonly type: "place";
      readonly source: PlaceSource;
      readonly at: Placement;
      /** What the source pane showed before the press that started the drag. */
      readonly restore?: TabId;
    }
  | { readonly type: "close"; readonly tab: TabId }
  | { readonly type: "activate"; readonly tab: TabId }
  | { readonly type: "unfloat"; readonly tab: TabId }
  | { readonly type: "focus"; readonly pane: PaneId }
  | { readonly type: "ratio"; readonly split: SplitId; readonly ratio: number }
  | { readonly type: "arm"; readonly pane: PaneId; readonly kind: ArmKind }
  /** A lone pane's split button: a launcher tab in a new pane to its right. */
  | { readonly type: "split-launcher"; readonly pane: PaneId }
  | {
      readonly type: "link-file";
      readonly source: ScopedThreadRef;
      readonly path: string;
      readonly line: number | null;
      /** A chat attachment of `source`; `path` is then its name. */
      readonly attachment?: ChatFileAttachment;
      /** The secondary Chat the link was clicked in, as placed at click time; none from a linked file. */
      readonly from?: { readonly tab: TabId; readonly placement: number };
    }
  /** A linked file's citation was shown; an `entry` from a replaced or reopened citation is a no-op. */
  | { readonly type: "linked-file-shown"; readonly tab: TabId; readonly entry: LinkedFileEntry }
  /** A thread link in a chat: the thread's Chat tab, shown where it is or placed beside the origin. */
  | { readonly type: "open-thread"; readonly thread: ScopedThreadRef }
  /** One Replies sub-thread as its own tab, shown where it is or placed beside the origin. */
  | {
      readonly type: "open-reply";
      readonly thread: ScopedThreadRef;
      readonly first: string;
      /**
       * `"find"` prefers another pane and keeps focus in splits. In strip view it focuses the
       * reply with Find on top. `"quote"` opens normally. Both replace the last revealed reply.
       */
      readonly reveal?: "find" | "quote";
      readonly keepRevealed?: true;
    };

const CHANGE_KINDS: Record<WorkAreaChange["type"], LayoutWriteKind> = {
  place: "user",
  close: "close",
  activate: "activate",
  unfloat: "automatic",
  focus: "automatic",
  ratio: "automatic",
  arm: "automatic",
  "split-launcher": "user",
  "link-file": "user",
  "linked-file-shown": "automatic",
  "open-thread": "user",
  "open-reply": "user",
};

export const writeKindOf = (change: WorkAreaChange): LayoutWriteKind => CHANGE_KINDS[change.type];

const surfacePayloadKinds = (layout: WorkAreaLayout, surfaces: readonly RightPanelSurface[]) => {
  const ids = new Set<string>(surfaces.map((surface) => surface.id));
  return leaves(layout.root).flatMap((pane) =>
    pane.tabs.filter((tab) => {
      const payload = layout.tabs[tab];
      return payload === undefined ? ids.has(tab) : payload.kind === "surface";
    }),
  );
};

function placeInBackground(
  layout: WorkAreaLayout,
  tab: TabId,
  kind: RightPanelKind | null,
): WorkAreaLayout {
  const armed = layout.armed;
  const target =
    (armed !== undefined && armed.kind === kind ? findPane(layout.root, armed.pane) : undefined) ??
    leaves(layout.root).find((pane) => !tabTraits(layout, pane.active).composer) ??
    findPane(layout.root, layout.focused) ??
    leaves(layout.root)[0]!;
  return setPane(layout, insertTabs(target, [tab], null, false));
}

/** Splits `target` for `ids` at the ratio that keeps both sides at their minimum, when one does. */
function splitFitted(
  layout: WorkAreaLayout,
  target: PaneId,
  edge: Edge,
  ids: readonly [TabId, ...TabId[]],
  view: WorkAreaView,
): { readonly layout: WorkAreaLayout; readonly pane: PaneId; readonly fits: boolean | null } {
  const split = splitPane(layout, target, edge, ids);
  const settled = settleSplit(split.layout, split.split, view);
  return { layout: settled, pane: split.pane, fits: fitsView(settled, view) };
}

/** A pane `tab` may join as drawn: a tab with a message box needs room for it. */
const roomFor =
  (layout: WorkAreaLayout, tab: TabId, view: WorkAreaView) =>
  (pane: PaneNode): boolean =>
    !tabTraits(layout, tab).composer ||
    fitsView(setPane(layout, insertTabs(pane, [tab], null, true)), view) !== false;

/** `tab` joined to `pane`, with the splits above it settled to give it room; null when none does. */
function joinSettled(
  layout: WorkAreaLayout,
  pane: PaneNode,
  tab: TabId,
  view: WorkAreaView,
): WorkAreaLayout | null {
  const joined = settleAround(setPane(layout, insertTabs(pane, [tab], null, true)), pane.id, view);
  return fitsView(joined, view) === false ? null : joined;
}

const holdsComposer = (layout: WorkAreaLayout, pane: PaneNode) =>
  pane.tabs.some((tab) => tabTraits(layout, tab).composer);

/** The launcher's pane when the armed open of `kind` was picked in it. */
function launcherPick(layout: WorkAreaLayout, kind: ArmKind | null): PaneNode | undefined {
  const armed = layout.armed;
  if (armed === undefined || armed.kind !== kind) return undefined;
  const pane = findPane(layout.root, armed.pane);
  return pane?.active === LAUNCHER ? pane : undefined;
}

/** `tab` moved right after `after`, in `after`'s pane, and shown there; a launcher gives way to it. */
function landAfter(layout: WorkAreaLayout, after: TabId, tab: TabId): WorkAreaLayout {
  const pane = paneHolding(layout.root, after)!;
  const moved = removeTabs(layout, new Set([tab]), { keep: pane.id });
  const kept = findPane(moved.root, pane.id)!;
  const rest = kept.tabs.filter((other) => other !== tab);
  const before = rest[rest.indexOf(after) + 1] ?? null;
  const placed = { ...setPane(moved, insertTabs(kept, [tab], before, true)), focused: pane.id };
  return after === LAUNCHER ? removeTabs(placed, new Set([LAUNCHER])) : placed;
}

function placeNew(
  layout: WorkAreaLayout,
  tab: TabId,
  kind: RightPanelKind | null,
  write: LayoutWriteKind,
  view: WorkAreaView,
): WorkAreaLayout {
  const user = write !== "automatic";
  const armed = user && layout.armed?.kind === kind ? layout.armed : undefined;
  const armedPane = armed ? findPane(layout.root, armed.pane) : undefined;
  if (armedPane) {
    if (armedPane.active === LAUNCHER) return launch(layout, tab, view);
    const placed = setPane(layout, insertTabs(armedPane, [tab], null, true));
    return withoutArmed(
      fitLanding(layout, { ...placed, focused: armedPane.id }, tab, armedPane.id, view),
    );
  }
  const focused = findPane(layout.root, layout.focused) ?? leaves(layout.root)[0]!;
  const fits = roomFor(layout, tab, view);
  // User opens spare only Chat tabs; automatic opens spare every tab with a message box.
  const covers = (pane: PaneNode) => tabTraits(layout, pane.active)[user ? "chat" : "composer"];
  const open = [focused, ...leaves(layout.root)].find((pane) => !covers(pane) && fits(pane));
  if (open) {
    const placed = setPane(layout, insertTabs(open, [tab], null, true));
    return user ? { ...placed, focused: open.id } : placed;
  }
  const split = splitFitted(layout, focused.id, "right", [tab], view);
  if (user ? split.fits !== false : split.fits === true) {
    return user ? { ...split.layout, focused: split.pane } : split.layout;
  }
  if (fits(focused)) return setPane(layout, insertTabs(focused, [tab], null, user));
  const settled = joinSettled(layout, focused, tab, view);
  if (settled) return settled;
  const home = leaves(layout.root).find((pane) => holdsComposer(layout, pane)) ?? focused;
  return setPane(layout, insertTabs(home, [tab], null, user));
}

const EPS = 1e-9;

const near = (left: number, right: number) => (Math.abs(left - right) > EPS ? left - right : 0);

const overlap = (start: number, size: number, otherStart: number, otherSize: number) =>
  Math.max(0, Math.min(start + size, otherStart + otherSize) - Math.max(start, otherStart));

// A rect lies toward an edge when its gap there is not negative.
const DIRECTIONS: Record<
  Edge,
  {
    readonly gap: (from: Rect, to: Rect) => number;
    readonly overlap: (from: Rect, to: Rect) => number;
  }
> = {
  right: { gap: (f, c) => c.x - (f.x + f.w), overlap: (f, c) => overlap(f.y, f.h, c.y, c.h) },
  left: { gap: (f, c) => f.x - (c.x + c.w), overlap: (f, c) => overlap(f.y, f.h, c.y, c.h) },
  bottom: { gap: (f, c) => c.y - (f.y + f.h), overlap: (f, c) => overlap(f.x, f.w, c.x, c.w) },
  top: { gap: (f, c) => f.y - (c.y + c.h), overlap: (f, c) => overlap(f.x, f.w, c.x, c.w) },
};
const BESIDE_ORDER: readonly Edge[] = ["right", "left", "bottom", "top"];

type PlacedPane = { readonly pane: PaneNode; readonly rect: Rect };

// Of `candidates` toward `edge` of `source`: smallest gap, longest shared edge, reading order.
function nearestToward(
  candidates: readonly PlacedPane[],
  source: Rect,
  edge: Edge,
): PlacedPane | undefined {
  const direction = DIRECTIONS[edge];
  const gap = (rect: Rect) => direction.gap(source, rect);
  const shared = (rect: Rect) => direction.overlap(source, rect);
  return candidates
    .filter(({ rect }) => gap(rect) >= -EPS)
    .toSorted(
      (left, right) =>
        near(gap(left.rect), gap(right.rect)) ||
        near(shared(right.rect), shared(left.rect)) ||
        near(left.rect.y, right.rect.y) ||
        near(left.rect.x, right.rect.x),
    )[0];
}

function otherPanes(layout: WorkAreaLayout, from: PaneId): PlacedPane[] {
  const rects = paneRects(layout.root);
  return leaves(layout.root).flatMap((pane) => {
    const rect = rects.get(pane.id);
    return pane.id !== from && rect !== undefined ? [{ pane, rect }] : [];
  });
}

/**
 * The pane a tab opened from `from` lands in when the layout has several: of the other panes it
 * `accepts` (else of all), those not showing a Chat (else all of those), the first direction of
 * right, left, down, up that holds one, then the smallest gap, the longest shared edge, and reading
 * order. `from` when it is alone.
 */
export function openBesideTarget(
  layout: WorkAreaLayout,
  from: PaneId,
  accepts: (pane: PaneNode) => boolean = () => true,
): PaneId {
  const source = paneRects(layout.root).get(from);
  if (source === undefined) return from;
  const all = otherPanes(layout, from);
  const accepted = all.filter(({ pane }) => accepts(pane));
  const others = accepted.length > 0 ? accepted : all;
  const open = others.filter(({ pane }) => !tabTraits(layout, pane.active).composer);
  const candidates = open.length > 0 ? open : others;
  for (const edge of BESIDE_ORDER) {
    const nearest = nearestToward(candidates, source, edge);
    if (nearest) return nearest.pane.id;
  }
  return from;
}

// A tab menu's move: `tab` joins the nearest pane toward `edge`; null when none lies there.
export function moveToward(layout: WorkAreaLayout, tab: TabId, edge: Edge): WorkAreaChange | null {
  const holder = paneHolding(layout.root, tab);
  const source = holder && paneRects(layout.root).get(holder.id);
  if (!holder || !source) return null;
  const target = nearestToward(otherPanes(layout, holder.id), source, edge);
  return target
    ? { type: "place", source: { tabs: [tab] }, at: { kind: "join", pane: target.pane.id } }
    : null;
}

/** The pane a user open started in, while it still holds the tab it started in. */
const sourcePane = (layout: WorkAreaLayout, write: LayoutWriteKind, origin: TabId | null) =>
  write === "user" && origin !== null ? paneHolding(layout.root, origin) : undefined;

/** A tab opened from `from`: a lone pane splits to its right when it can, else it lands beside. */
function placeBeside(
  layout: WorkAreaLayout,
  tab: TabId,
  from: PaneId,
  view: WorkAreaView,
): WorkAreaLayout {
  if (leaves(layout.root).length === 1) {
    const split = splitFitted(layout, from, "right", [tab], view);
    if (split.fits !== false) return { ...split.layout, focused: split.pane };
  }
  const room = roomFor(layout, tab, view);
  const target = findPane(layout.root, openBesideTarget(layout, from, room))!;
  if (target.id === from || room(target)) {
    return { ...setPane(layout, insertTabs(target, [tab], null, true)), focused: target.id };
  }
  // No other pane has a message box's room as drawn: make room there, else join the source pane.
  const settled = joinSettled(layout, target, tab, view);
  if (settled) return { ...settled, focused: target.id };
  const source = findPane(layout.root, from)!;
  return { ...setPane(layout, insertTabs(source, [tab], null, true)), focused: from };
}

function fitLanding(
  layout: WorkAreaLayout,
  landed: WorkAreaLayout,
  tab: TabId,
  from: PaneId,
  view: WorkAreaView,
): WorkAreaLayout {
  if (fitsView(landed, view) !== false || fitsView(layout, view) === false) return landed;
  const settled = settleAround(landed, paneHolding(landed.root, tab)!.id, view);
  if (fitsView(settled, view) !== false) return settled;
  return placeBeside(removeTabs(layout, new Set([tab]), { keep: from }), tab, from, view);
}

function landAdjacent(
  layout: WorkAreaLayout,
  after: TabId,
  tab: TabId,
  view: WorkAreaView,
): WorkAreaLayout {
  const from = paneHolding(layout.root, after)!.id;
  const landed = fitLanding(layout, landAfter(layout, after, tab), tab, from, view);
  return after === LAUNCHER && paneHolding(landed.root, LAUNCHER)
    ? removeTabs(landed, new Set([LAUNCHER]))
    : landed;
}

/** A pick in the launcher: `tab` takes the launcher's place. */
const launch = (layout: WorkAreaLayout, tab: TabId, view: WorkAreaView) =>
  withoutArmed(landAdjacent(layout, LAUNCHER, tab, view));

function showPlaced(
  layout: WorkAreaLayout,
  tab: TabId,
  kind: RightPanelKind | null,
  write: LayoutWriteKind,
  view: WorkAreaView,
): WorkAreaLayout {
  const pane = paneHolding(layout.root, tab);
  if (!pane) return layout;
  if (write !== "automatic") {
    return { ...setPane(layout, { ...pane, active: tab }), focused: pane.id };
  }
  if (pane.active === tab || !tabTraits(layout, pane.active).composer) {
    return setPane(layout, { ...pane, active: tab });
  }
  return placeNew(removeTabs(layout, new Set([tab])), tab, kind, write, view);
}

const isPlaceholder = (surface: RightPanelSurface | undefined): boolean =>
  (surface?.kind === "preview" && surface.resourceId === null) ||
  (surface?.kind === "device" && surface.target === undefined);

function openedFrom(
  layout: WorkAreaLayout,
  prevLive: string | null,
  requested: string | null,
  write: LayoutWriteKind,
  from: OpenFrom | null,
): WorkAreaLayout {
  if (write !== "user" || from === null) return layout;
  const armed =
    from.armed !== undefined && findPane(layout.root, from.armed.pane)
      ? { ...layout, armed: from.armed }
      : layout;
  if (requested === null || requested === prevLive || from.existing === undefined) return armed;
  const tab = surfaceTabId(requested);
  return from.existing.has(tab) || !paneHolding(armed.root, tab)
    ? armed
    : removeTabs(armed, new Set([tab]));
}

function placeWrite(
  settled: WorkAreaLayout,
  prevSurfaces: readonly RightPanelSurface[],
  prevLive: string | null,
  surfaces: readonly RightPanelSurface[],
  requested: string | null,
  write: LayoutWriteKind,
  view: WorkAreaView,
  openFrom: OpenFrom | null,
): WorkAreaLayout {
  const layout = openedFrom(settled, prevLive, requested, write, openFrom);
  const origin = openFrom?.tab ?? null;
  const byId = new Map<string, RightPanelSurface>(surfaces.map((surface) => [surface.id, surface]));
  const kindOf = (tab: TabId) => byId.get(tab)?.kind ?? null;
  const placed = surfacePayloadKinds(layout, surfaces);
  const placedSet = new Set(placed);
  const removed = placed.filter((tab) => !byId.has(tab));
  const added = surfaces.flatMap((surface) => {
    const tab = surfaceTabId(surface.id);
    return placedSet.has(tab) || tab === layout.floating?.tab ? [] : [tab];
  });
  const target =
    requested !== null && requested !== prevLive && byId.has(requested)
      ? surfaceTabId(requested)
      : null;
  const removedLive =
    prevLive !== null && !byId.has(prevLive)
      ? prevSurfaces.find((surface) => surface.id === prevLive)
      : undefined;
  // A close or an automatic write that loses the shown surface only picks a fallback, unless the
  // target is that placeholder's own replacement.
  const maintenance =
    target !== null &&
    removedLive !== undefined &&
    (write === "close" || write === "automatic") &&
    !(isPlaceholder(removedLive) && added.includes(target) && kindOf(target) === removedLive.kind);
  const activated = maintenance ? null : target;
  const dropped =
    write === "user" && openFrom?.drop?.live() && requested !== null && byId.has(requested)
      ? surfaceTabId(requested)
      : null;
  // Only a real activation docks the floating tab; a fallback after a removal leaves it floating.
  const shows = activated ?? dropped;
  const docked = shows !== null && shows === layout.floating?.tab;
  let next = docked ? unfloatTab(layout, shows) : layout;
  let slot: TabId | null = null;
  const sourced = sourcePane(layout, write, origin) !== undefined;
  if (
    dropped === null &&
    activated !== null &&
    !sourced &&
    added.includes(activated) &&
    removed.length > 0
  ) {
    const candidate = removed.find((tab) => tab === prevLive) ?? removed[0]!;
    const pane = paneHolding(next.root, candidate)!;
    const tabs = pane.tabs.map((tab) => (tab === candidate ? activated : tab));
    if ((pane.active === candidate || !tabTraits(next, pane.active).composer) && isNonEmpty(tabs)) {
      slot = candidate;
      next = setPane(next, {
        ...pane,
        tabs,
        active: pane.active === candidate ? activated : pane.active,
      });
    }
  }
  next = removeTabs(next, new Set(removed.filter((tab) => tab !== slot)));
  for (const tab of added) {
    if (tab !== activated && tab !== dropped) next = placeInBackground(next, tab, kindOf(tab));
  }
  const landed = dropped === null ? null : landAt(next, dropped, openFrom!.drop!.at, view);
  if (landed !== null) return withoutArmed(landed);
  if (dropped !== null && dropped !== activated && !paneHolding(next.root, dropped)) {
    next = placeInBackground(next, dropped, kindOf(dropped));
  }
  if (activated === null) return next;
  const after =
    write === "user" &&
    openFrom?.adjacent &&
    origin !== activated &&
    paneHolding(next.root, openFrom.tab)
      ? openFrom.tab
      : null;
  if (after !== null) {
    next = landAdjacent(next, after, activated, view);
  } else if (slot !== null) {
    const pane = paneHolding(next.root, activated)!;
    if (write === "automatic") return next;
    next = { ...setPane(next, { ...pane, active: activated }), focused: pane.id };
  } else if (added.includes(activated) || (docked && !paneHolding(next.root, activated))) {
    const from = sourcePane(next, write, origin);
    next = from
      ? placeBeside(next, activated, from.id, view)
      : placeNew(next, activated, kindOf(activated), write, view);
  } else {
    const pick = write === "automatic" ? undefined : launcherPick(next, kindOf(activated));
    next = pick
      ? launch(next, activated, view)
      : showPlaced(next, activated, kindOf(activated), write, view);
  }
  return write === "automatic" ? next : withoutArmed(next);
}

/** Forces a surface visible for an agent reveal, covering a Chat or placing it if it floats. */
function revealed(
  layout: WorkAreaLayout,
  surfaces: readonly RightPanelSurface[],
  requested: string | null,
  view: WorkAreaView,
): WorkAreaLayout {
  const surface = surfaces.find((candidate) => candidate.id === requested);
  if (surface === undefined) return layout;
  const tab = surfaceTabId(surface.id);
  const docked = unfloatTab(layout, tab);
  const placed =
    layout.floating?.tab === tab && !paneHolding(docked.root, tab)
      ? placeNew(docked, tab, surface.kind, "automatic", view)
      : docked;
  const pane = paneHolding(placed.root, tab);
  if (!pane || tabShown(placed, view, tab)) return placed;
  const shown = setPane(placed, { ...pane, active: tab });
  return isStripView(shown, view) ? { ...shown, focused: pane.id } : shown;
}

function nodeEqual(left: LayoutNode, right: LayoutNode): boolean {
  if (left === right) return true;
  if (left.kind === "pane" || right.kind === "pane") {
    return (
      left.kind === "pane" &&
      right.kind === "pane" &&
      left.id === right.id &&
      left.active === right.active &&
      left.tabs.length === right.tabs.length &&
      left.tabs.every((tab, index) => tab === right.tabs[index])
    );
  }
  return (
    left.id === right.id &&
    left.axis === right.axis &&
    left.ratio === right.ratio &&
    nodeEqual(left.first, right.first) &&
    nodeEqual(left.second, right.second)
  );
}

function layoutEqual(left: WorkAreaLayout, right: WorkAreaLayout): boolean {
  const leftTabs = Object.keys(left.tabs);
  return (
    left.focused === right.focused &&
    left.seq === right.seq &&
    left.armed?.pane === right.armed?.pane &&
    left.armed?.kind === right.armed?.kind &&
    left.floating === right.floating &&
    left.revealed === right.revealed &&
    leftTabs.length === Object.keys(right.tabs).length &&
    leftTabs.every((tab) => left.tabs[asTabId(tab)] === right.tabs[asTabId(tab)]) &&
    nodeEqual(left.root, right.root)
  );
}

/**
 * Restores every invariant against the record's surfaces: each surface placed once and no surface
 * tab without its surface, at least one Chat, panes non-empty with their active tab, the focused
 * pane present, ratios clamped and `seq` above every minted id. Same reference when nothing changes.
 */
export function repairWorkArea(
  layout: WorkAreaLayout,
  surfaces: readonly RightPanelSurface[],
): WorkAreaLayout {
  const surfaceIds = new Set<string>(surfaces.map((surface) => surface.id));
  const seen = new Set<TabId>();
  const keep = (tab: TabId) => {
    if (seen.has(tab)) return false;
    const payload = layout.tabs[tab];
    // One tab per thread: upstream's side-thread tab wins over a Chat tab of the same thread.
    const valid =
      payload === undefined || payload.kind === "surface"
        ? surfaceIds.has(tab)
        : payload.kind !== "secondary-chat" ||
          !surfaceIds.has(sideThreadTabId(payload.thread.threadId));
    if (valid) seen.add(tab);
    return valid;
  };
  const alive = new Set<PaneId>();
  const root = mapPanes(layout.root, (pane) => {
    const tabs = pane.tabs.filter(keep);
    if (!isNonEmpty(tabs)) return null;
    alive.add(pane.id);
    const active = tabs.includes(pane.active) ? pane.active : tabs[0];
    return tabs.length === pane.tabs.length && active === pane.active
      ? pane
      : { ...pane, tabs, active };
  });
  let next: WorkAreaLayout;
  if (root === null) {
    next = defaultLayout(layout.seq);
  } else {
    const clamped = mapSplits(root, (split) => {
      const ratio = clampRatio(split.ratio);
      return ratio === split.ratio ? split : { ...split, ratio };
    });
    const focused = alive.has(layout.focused)
      ? layout.focused
      : (focusAfterRemoval(layout.root, layout.focused, alive) ?? leaves(clamped)[0]!.id);
    next = { ...layout, root: clamped, focused };
  }
  const floating =
    layout.floating !== undefined &&
    surfaceIds.has(layout.floating.tab) &&
    !seen.has(layout.floating.tab)
      ? layout.floating.tab
      : undefined;
  if (floating === undefined && next.floating !== undefined) next = withoutFloating(next);
  for (const surface of surfaces) {
    const tab = surfaceTabId(surface.id);
    if (!seen.has(tab) && tab !== floating && !paneHolding(next.root, tab)) {
      next = placeInBackground(next, tab, surface.kind);
    }
  }
  if (chatTabsIn(next, layout.tabs).length === 0) {
    const focused = findPane(next.root, next.focused)!;
    next = setPane(next, insertTabs(focused, [PRIMARY_CHAT], null, true));
  }
  const tabs: Record<TabId, WorkAreaTab> = {};
  let minted = -1;
  const mint = (value: string, pattern: RegExp) => {
    const match = pattern.exec(value);
    if (match) minted = Math.max(minted, Number(match[1]));
  };
  mapPanes(next.root, (pane) => {
    mint(pane.id, PANE_ID);
    for (const tab of pane.tabs) {
      const payload =
        layout.tabs[tab] ?? (tab === PRIMARY_CHAT ? PRIMARY_PAYLOAD : { kind: "surface" });
      tabs[tab] = payload;
    }
    return pane;
  });
  mapSplits(next.root, (split) => {
    mint(split.id, SPLIT_ID);
    return split;
  });
  const sameTabs =
    Object.keys(tabs).length === Object.keys(layout.tabs).length &&
    Object.entries(tabs).every(([tab, payload]) => layout.tabs[asTabId(tab)] === payload);
  next = {
    ...next,
    tabs: sameTabs ? layout.tabs : tabs,
    seq: Math.max(next.seq, minted + 1),
  };
  if (next.armed !== undefined && !findPane(next.root, next.armed.pane)) next = withoutArmed(next);
  if (next.revealed !== undefined && !paneHolding(next.root, next.revealed)) {
    next = withRevealed(next, undefined);
  }
  return layoutEqual(next, layout) ? layout : next;
}

function chatTabsIn(layout: WorkAreaLayout, payloads: WorkAreaLayout["tabs"]): TabId[] {
  return leaves(layout.root).flatMap((pane) =>
    pane.tabs.filter((tab) => traitsOf(tab, payloads[tab] ?? layout.tabs[tab]).chat),
  );
}

function withMirrors(next: ThreadRightPanelState, layout: WorkAreaLayout): ThreadRightPanelState {
  const { surfaces } = next;
  const stored = isDefaultLayout(layout) ? undefined : layout;
  const focused = findPane(layout.root, layout.focused);
  const activeSurfaceId =
    focused !== undefined && surfaces.some((surface) => surface.id === focused.active)
      ? focused.active
      : null;
  const isOpen = surfaces.length > (layout.floating === undefined ? 0 : 1);
  if (
    next.isOpen === isOpen &&
    next.activeSurfaceId === activeSurfaceId &&
    next.workArea === stored &&
    next.maximized === undefined
  ) {
    return next;
  }
  const { maximized: _maximized, workArea: _workArea, ...rest } = next;
  return { ...rest, isOpen, activeSurfaceId, ...(stored ? { workArea: stored } : {}) };
}

/**
 * The store's write path for thread records. `prev` is settled; `next` is what a pane-blind writer
 * or `applyWorkAreaChange` made. The write's own activation says what to show: `next`'s active
 * surface differs from `prev`'s live mirror, or a surface was added active. Settling a settled
 * record returns it by reference.
 */
export function reconcileWorkArea(
  prev: ThreadRightPanelState,
  next: ThreadRightPanelState,
  write: LayoutWriteKind,
  view: WorkAreaView,
  origin: OpenFrom | null = null,
  playing: TabId | null = null,
): ThreadRightPanelState {
  const { surfaces } = next;
  const floated = floatedByClose(prev, next, write, playing);
  const layout =
    next.workArea !== prev.workArea
      ? (next.workArea ?? DEFAULT_LAYOUT)
      : floated !== null
        ? floatTab(resolveLayout(prev), floated, view)
        : write === "reveal"
          ? revealed(resolveLayout(prev), surfaces, next.activeSurfaceId, view)
          : placeWrite(
              resolveLayout(prev),
              prev.surfaces,
              prev.activeSurfaceId,
              surfaces,
              next.activeSurfaceId,
              write,
              view,
              origin,
            );
  return withMirrors(next, repairWorkArea(keptFloat(layout, view), surfaces));
}

const sideThreadTabId = (threadId: string) => surfaceTabId(`thread:${threadId}`);

const SURFACE_PAYLOAD: WorkAreaTab = { kind: "surface" };

// Unique across layouts and reloads, so a link captured from a closed Chat never matches its successor.
let lastPlacement = Date.now();

const sameThread = (left: ScopedThreadRef, right: ScopedThreadRef) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

/** `thread`'s Chat tab: the primary Chat for the owner, else a secondary Chat, made on first use. */
function chatTabFor(
  layout: WorkAreaLayout,
  thread: ScopedThreadRef,
  owner: ScopedThreadRef,
): { readonly layout: WorkAreaLayout; readonly tab: TabId } {
  if (sameThread(thread, owner)) {
    return {
      layout: withPayload(layout, PRIMARY_CHAT, layout.tabs[PRIMARY_CHAT] ?? PRIMARY_PAYLOAD),
      tab: PRIMARY_CHAT,
    };
  }
  const tab = secondaryChatTabId(thread);
  if (layout.tabs[tab] !== undefined) return { layout, tab };
  return {
    layout: withPayload(layout, tab, {
      kind: "secondary-chat",
      thread: scopeThreadRef(thread.environmentId, thread.threadId),
      placement: (lastPlacement += 1),
    }),
    tab,
  };
}

function showOrPlace(
  layout: WorkAreaLayout,
  tab: TabId,
  kind: RightPanelKind | null,
  view: WorkAreaView,
  from: OpenFrom | null,
): WorkAreaLayout {
  const landed = from?.drop?.live() ? landAt(layout, tab, from.drop.at, view) : null;
  if (landed !== null) return withoutArmed(landed);
  const source = sourcePane(layout, "user", from?.tab ?? null);
  const shown = paneHolding(layout.root, tab)
    ? showPlaced(layout, tab, kind, "user", view)
    : source && from?.adjacent
      ? landAdjacent(layout, from.tab, tab, view)
      : source
        ? placeBeside(layout, tab, source.id, view)
        : placeNew(layout, tab, kind, "user", view);
  return withoutArmed(shown);
}

function place(
  layout: WorkAreaLayout,
  change: Extract<WorkAreaChange, { type: "place" }>,
  owner: ScopedThreadRef,
  view: WorkAreaView,
): WorkAreaLayout {
  let next = layout;
  const ids: TabId[] = [];
  if ("threads" in change.source) {
    for (const thread of change.source.threads) {
      const chat = chatTabFor(next, thread, owner);
      next = chat.layout;
      ids.push(chat.tab);
    }
  } else {
    ids.push(...change.source.tabs.filter((tab) => next.tabs[tab] !== undefined));
  }
  return moveTabs(layout, next, [...new Set(ids)], change.at, change.restore, view);
}

// `layout` itself when the move does not happen.
function moveTabs(
  layout: WorkAreaLayout,
  withPayloads: WorkAreaLayout,
  moving: readonly TabId[],
  at: Placement,
  restore: TabId | undefined,
  view: WorkAreaView,
): WorkAreaLayout {
  let next = withPayloads;
  const target =
    (at.kind === "strip" && at.before !== null ? paneHolding(next.root, at.before) : undefined) ??
    findPane(next.root, at.pane);
  if (!isNonEmpty(moving) || !target) return layout;
  const movingSet = new Set(moving);
  const remaining = target.tabs.filter((tab) => !movingSet.has(tab));
  next = removeTabs(next, movingSet, {
    keep: target.id,
    ...(restore === undefined ? {} : { restore }),
  });
  if (at.kind === "edge") {
    if (!isNonEmpty(remaining)) return layout;
    const active =
      restore !== undefined && remaining.includes(restore)
        ? restore
        : nearestRemaining(target.tabs, target.active, movingSet)!;
    next = setPane(next, { ...target, tabs: remaining, active });
    const split = splitFitted(next, target.id, at.edge, moving, view);
    if (split.fits === false) return layout;
    return withoutArmed({ ...split.layout, focused: split.pane });
  }
  const before = at.kind === "strip" ? at.before : null;
  const inserted = {
    ...setPane(next, insertTabs(target, moving, before, true)),
    focused: target.id,
  };
  // The strip view has no fit check and hides the divider, so make room for a Chat that joins.
  const gainsChat =
    !holdsComposer(next, target) && moving.some((tab) => tabTraits(next, tab).composer);
  const joined =
    gainsChat && isStripView(layout, view) ? settleAround(inserted, target.id, view) : inserted;
  if (launcherPick(layout, "chat")?.id !== target.id) return withoutArmed(joined);
  // The launcher's Chat pick takes the launcher's place when that pane can be made wide enough.
  const launched = settleAround(removeTabs(joined, new Set([LAUNCHER])), target.id, view);
  const home = leaves(next.root).find((pane) => pane.id !== target.id && holdsComposer(next, pane));
  if (fitsView(launched, view) !== false || home === undefined) return withoutArmed(launched);
  return withoutArmed({ ...setPane(next, insertTabs(home, moving, null, true)), focused: home.id });
}

// A drop's move of one tab; null when its pane is gone, or when panes that fit would no longer fit.
function landAt(
  layout: WorkAreaLayout,
  tab: TabId,
  at: Placement,
  view: WorkAreaView,
): WorkAreaLayout | null {
  const base = withPayload(layout, tab, layout.tabs[tab] ?? SURFACE_PAYLOAD);
  const moved = moveTabs(base, base, [tab], at, undefined, view);
  if (moved === base) return null;
  return fitsView(moved, view) === false && fitsView(base, view) !== false ? null : moved;
}

/** `updateWorkArea`'s reducer. The write path then repairs the result and writes the mirrors. */
export function applyWorkAreaChange(
  layout: WorkAreaLayout,
  change: WorkAreaChange,
  owner: ScopedThreadRef,
  view: WorkAreaView,
  openFrom: OpenFrom | null = null,
): WorkAreaLayout {
  const next = changedLayout(layout, change, owner, view, openFrom);
  const { revealed } = layout;
  return revealed !== undefined && takesOver(layout, revealed, change)
    ? withRevealed(next, undefined)
    : next;
}

function changedLayout(
  layout: WorkAreaLayout,
  change: WorkAreaChange,
  owner: ScopedThreadRef,
  view: WorkAreaView,
  openFrom: OpenFrom | null,
): WorkAreaLayout {
  switch (change.type) {
    case "place":
      return place(layout, change, owner, view);
    case "close": {
      const payload = layout.tabs[change.tab];
      if (payload === undefined || payload.kind === "surface") return layout;
      if (tabTraits(layout, change.tab).chat && chatTabs(layout).length <= 1) return layout;
      return removeTabs(layout, new Set([change.tab]));
    }
    case "activate": {
      const pane = paneHolding(layout.root, change.tab);
      if (!pane) return layout;
      return withoutArmed({
        ...setPane(layout, { ...pane, active: change.tab }),
        focused: pane.id,
      });
    }
    case "unfloat":
      return unfloatTab(layout, change.tab);
    case "focus":
      if (!findPane(layout.root, change.pane)) return layout;
      return withoutArmed(
        layout.focused === change.pane ? layout : { ...layout, focused: change.pane },
      );
    case "ratio": {
      const ratio = fittedRatio(layout, change.split, change.ratio, view);
      if (ratio === null) return layout;
      const root = mapSplits(layout.root, (split) =>
        split.id === change.split && split.ratio !== ratio ? { ...split, ratio } : split,
      );
      return root === layout.root ? layout : { ...layout, root };
    }
    case "arm":
      if (!findPane(layout.root, change.pane)) return layout;
      return { ...layout, armed: { pane: change.pane, kind: change.kind } };
    case "split-launcher": {
      const lone = leaves(layout.root);
      if (lone.length !== 1 || lone[0]!.id !== change.pane || lone[0]!.tabs.includes(LAUNCHER)) {
        return layout;
      }
      const split = splitFitted(
        withPayload(layout, LAUNCHER, { kind: "launcher" }),
        change.pane,
        "right",
        [LAUNCHER],
        view,
      );
      if (split.fits === false) return layout;
      return withoutArmed({ ...split.layout, focused: split.pane });
    }
    case "link-file": {
      const from = change.from && layout.tabs[change.from.tab];
      if (
        change.from !== undefined &&
        (from?.kind !== "secondary-chat" || from.placement !== change.from.placement)
      ) {
        return layout;
      }
      const { attachment } = change;
      const path = attachment === undefined ? workspaceEntryPath(change.path) : change.path;
      const tab = linkedFileTabId(change.source, path, attachment?.id);
      const existing = layout.tabs[tab];
      const reveal = existing?.kind === "linked-file" ? existing.reveal + 1 : 1;
      const next = withPayload(layout, tab, {
        kind: "linked-file",
        source: change.source,
        path,
        line: change.line,
        reveal,
        ...(attachment === undefined ? {} : { attachment }),
      });
      return showOrPlace(next, tab, "file", view, openFrom);
    }
    case "linked-file-shown": {
      const payload = layout.tabs[change.tab];
      if (
        payload?.kind !== "linked-file" ||
        payload.shown ||
        linkedFileEntry(change.tab, payload) !== change.entry
      ) {
        return layout;
      }
      return withPayload(layout, change.tab, shownLinkedFile(payload));
    }
    case "open-thread": {
      const side = sideThreadTabId(change.thread.threadId);
      if (paneHolding(layout.root, side)) return showOrPlace(layout, side, null, view, openFrom);
      const chat = chatTabFor(layout, change.thread, owner);
      return showOrPlace(chat.layout, chat.tab, null, view, openFrom);
    }
    case "open-reply": {
      const tab = replyTabId(change.thread, change.first);
      if (!change.reveal) {
        const shown = showOrPlace(withReply(layout, tab, change), tab, null, view, openFrom);
        return layout.revealed === tab ? withRevealed(shown, undefined) : shown;
      }
      const fresh = layout.tabs[tab] === undefined;
      const replaced =
        fresh && layout.revealed !== undefined && !change.keepRevealed
          ? replaceTab(layout, layout.revealed, tab)
          : layout;
      const reveals = fresh ? tab : layout.revealed;
      if (change.reveal === "quote") {
        return withRevealed(
          showOrPlace(withReply(replaced, tab, change), tab, null, view, openFrom),
          reveals,
        );
      }
      const next = revealReply(withReply(replaced, tab, change), tab, view, openFrom);
      // One strip draws only the focused pane, so there the reveal's focus wins.
      const focused =
        !isStripView(next, view) && findPane(next.root, layout.focused)
          ? layout.focused
          : next.focused;
      return withRevealed({ ...next, focused }, reveals);
    }
  }
}

function withReply(
  layout: WorkAreaLayout,
  tab: TabId,
  change: Extract<WorkAreaChange, { type: "open-reply" }>,
): WorkAreaLayout {
  if (layout.tabs[tab] !== undefined) return layout;
  return withPayload(layout, tab, {
    kind: "sub-thread",
    thread: scopeThreadRef(change.thread.environmentId, change.thread.threadId),
    first: change.first,
  });
}

function replaceTab(layout: WorkAreaLayout, from: TabId, to: TabId): WorkAreaLayout {
  const pane = paneHolding(layout.root, from);
  if (!pane) return layout;
  const tabs = pane.tabs.map((tab) => (tab === from ? to : tab));
  return isNonEmpty(tabs)
    ? setPane(layout, { ...pane, tabs, active: pane.active === from ? to : pane.active })
    : layout;
}

function revealReply(
  layout: WorkAreaLayout,
  tab: TabId,
  view: WorkAreaView,
  openFrom: OpenFrom | null,
): WorkAreaLayout {
  const origin = openFrom?.tab ?? null;
  const shown = showOrPlace(layout, tab, null, view, openFrom);
  if (origin === null || !tabShown(layout, view, origin) || tabShown(shown, view, origin)) {
    return shown;
  }
  const source = paneHolding(layout.root, origin)!;
  // One strip draws one tab: the reply shows right after the origin, whose Find stays one tab back.
  if (isStripView(layout, view)) {
    const rest = source.tabs.filter((other) => other !== tab);
    const after = rest[rest.indexOf(origin) + 1];
    const lifted = removeTabs(layout, new Set([tab]), { keep: source.id });
    const kept = findPane(lifted.root, source.id)!;
    return setPane(lifted, insertTabs(kept, [tab], after ?? null, true));
  }
  // A reply in the origin's pane moves to another pane when one has room for it.
  if (paneHolding(layout.root, tab)?.id === source.id) {
    const moved = showOrPlace(removeTabs(layout, new Set([tab])), tab, null, view, openFrom);
    if (tabShown(moved, view, origin) && tabShown(moved, view, tab)) return moved;
  }
  // The origin's Find field keeps the keyboard; the match shows once this tab is activated.
  return paneHolding(layout.root, tab)
    ? layout
    : setPane(layout, insertTabs(source, [tab], null, false));
}

function takesOver(layout: WorkAreaLayout, tab: TabId, change: WorkAreaChange): boolean {
  switch (change.type) {
    case "activate":
      return change.tab === tab;
    case "focus":
      return findPane(layout.root, change.pane)?.active === tab;
    case "place":
      return "tabs" in change.source && change.source.tabs.includes(tab);
    default:
      return false;
  }
}

/**
 * Where `change` puts what it places, as fractions of the work area; null when it changes nothing
 * or its result does not fit `view`.
 */
export function landingRect(
  layout: WorkAreaLayout,
  change: WorkAreaChange,
  owner: ScopedThreadRef,
  view: WorkAreaView,
): Rect | null {
  const next = applyWorkAreaChange(layout, change, owner, view);
  if (next === layout || fitsView(next, view) !== true) return null;
  return paneRects(next.root).get(next.focused) ?? null;
}
