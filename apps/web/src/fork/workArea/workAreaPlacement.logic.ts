import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelKind, RightPanelSurface, ThreadRightPanelState } from "~/rightPanelStore";
import type { ChatFileAttachment } from "~/types";

import {
  asTabId,
  chatTabs,
  DEFAULT_LAYOUT,
  defaultLayout,
  type Edge,
  findPane,
  focusAfterRemoval,
  insertTabs,
  isChatTab,
  isDefaultLayout,
  isNonEmpty,
  type LayoutNode,
  leaves,
  linkedFileTabId,
  mapPanes,
  mapSplits,
  PANE_ID,
  type PaneId,
  paneHolding,
  PRIMARY_CHAT,
  PRIMARY_PAYLOAD,
  removeTabs,
  resolveLayout,
  secondaryChatTabId,
  setPane,
  SPLIT_ID,
  type SplitId,
  splitPane,
  surfaceTabId,
  type TabId,
  type WorkAreaLayout,
  type WorkAreaTab,
  withoutArmed,
  withPayload,
  workspaceEntryPath,
} from "./workArea.logic";
import {
  canSplit,
  clampRatio,
  paneRects,
  type Rect,
  type WorkAreaView,
} from "./workAreaGeometry.logic";

/** How a store write came about. "activate" is a tab press. */
export type LayoutWriteKind = "user" | "close" | "automatic" | "activate";

export type Placement =
  | { readonly kind: "strip"; readonly pane: PaneId; readonly before: TabId | null }
  | { readonly kind: "edge"; readonly pane: PaneId; readonly edge: Edge }
  | { readonly kind: "join"; readonly pane: PaneId };

type PlaceSource =
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
  | { readonly type: "focus"; readonly pane: PaneId }
  | { readonly type: "ratio"; readonly split: SplitId; readonly ratio: number }
  | { readonly type: "arm"; readonly pane: PaneId; readonly kind: RightPanelKind }
  | {
      readonly type: "link-file";
      readonly source: ScopedThreadRef;
      readonly path: string;
      readonly line: number | null;
      /** A chat attachment of `source`; `path` is then its name. */
      readonly attachment?: ChatFileAttachment;
      /** The secondary Chat the link was clicked in, as placed at click time; none from a linked file. */
      readonly from?: { readonly tab: TabId; readonly placement: number };
    };

const CHANGE_KINDS: Record<WorkAreaChange["type"], LayoutWriteKind> = {
  place: "user",
  close: "close",
  activate: "activate",
  focus: "automatic",
  ratio: "automatic",
  arm: "automatic",
  "link-file": "user",
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
    leaves(layout.root).find((pane) => !isChatTab(layout, pane.active)) ??
    findPane(layout.root, layout.focused) ??
    leaves(layout.root)[0]!;
  return setPane(layout, insertTabs(target, [tab], null, false));
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
    return withoutArmed({
      ...setPane(layout, insertTabs(armedPane, [tab], null, true)),
      focused: armedPane.id,
    });
  }
  const focused = findPane(layout.root, layout.focused) ?? leaves(layout.root)[0]!;
  const open = !isChatTab(layout, focused.active)
    ? focused
    : leaves(layout.root).find((pane) => !isChatTab(layout, pane.active));
  if (open) {
    const placed = setPane(layout, insertTabs(open, [tab], null, true));
    return user ? { ...placed, focused: open.id } : placed;
  }
  const fits = canSplit(layout, view, focused.id, "row");
  if (user ? fits !== false : fits === true) {
    const split = splitPane(layout, focused.id, "right", [tab]);
    return user ? { ...split.layout, focused: split.pane } : split.layout;
  }
  return setPane(layout, insertTabs(focused, [tab], null, user));
}

const EPS = 1e-9;

const near = (left: number, right: number) => (Math.abs(left - right) > EPS ? left - right : 0);

const overlap = (start: number, size: number, otherStart: number, otherSize: number) =>
  Math.max(0, Math.min(start + size, otherStart + otherSize) - Math.max(start, otherStart));

// In the order looked in. A rect lies in a direction when its gap there is not negative.
const DIRECTIONS: readonly {
  readonly gap: (from: Rect, to: Rect) => number;
  readonly overlap: (from: Rect, to: Rect) => number;
}[] = [
  { gap: (f, c) => c.x - (f.x + f.w), overlap: (f, c) => overlap(f.y, f.h, c.y, c.h) },
  { gap: (f, c) => f.x - (c.x + c.w), overlap: (f, c) => overlap(f.y, f.h, c.y, c.h) },
  { gap: (f, c) => c.y - (f.y + f.h), overlap: (f, c) => overlap(f.x, f.w, c.x, c.w) },
  { gap: (f, c) => f.y - (c.y + c.h), overlap: (f, c) => overlap(f.x, f.w, c.x, c.w) },
];

/**
 * The pane a tab opened from `from` lands in when the layout has several: of the other panes not
 * showing a Chat (else of all the others), the first direction of right, left, down, up that holds
 * one, then the smallest gap, the longest shared edge, and reading order. `from` when it is alone.
 */
export function openBesideTarget(layout: WorkAreaLayout, from: PaneId): PaneId {
  const rects = paneRects(layout.root);
  const source = rects.get(from);
  if (source === undefined) return from;
  const others = leaves(layout.root).flatMap((pane) => {
    const rect = rects.get(pane.id);
    return pane.id !== from && rect !== undefined ? [{ pane, rect }] : [];
  });
  const open = others.filter(({ pane }) => !isChatTab(layout, pane.active));
  const candidates = open.length > 0 ? open : others;
  for (const direction of DIRECTIONS) {
    const gap = (rect: Rect) => direction.gap(source, rect);
    const shared = (rect: Rect) => direction.overlap(source, rect);
    const [nearest] = candidates
      .filter(({ rect }) => gap(rect) >= -EPS)
      .toSorted(
        (left, right) =>
          near(gap(left.rect), gap(right.rect)) ||
          near(shared(right.rect), shared(left.rect)) ||
          near(left.rect.y, right.rect.y) ||
          near(left.rect.x, right.rect.x),
      );
    if (nearest) return nearest.pane.id;
  }
  return from;
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
  if (leaves(layout.root).length === 1 && canSplit(layout, view, from, "row") !== false) {
    const split = splitPane(layout, from, "right", [tab]);
    return { ...split.layout, focused: split.pane };
  }
  const target = findPane(layout.root, openBesideTarget(layout, from))!;
  return { ...setPane(layout, insertTabs(target, [tab], null, true)), focused: target.id };
}

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
  if (pane.active === tab || !isChatTab(layout, pane.active)) {
    return setPane(layout, { ...pane, active: tab });
  }
  return placeNew(removeTabs(layout, new Set([tab])), tab, kind, write, view);
}

const isPlaceholder = (surface: RightPanelSurface | undefined): boolean =>
  (surface?.kind === "preview" && surface.resourceId === null) ||
  (surface?.kind === "device" && surface.target === undefined);

function placeWrite(
  layout: WorkAreaLayout,
  prevSurfaces: readonly RightPanelSurface[],
  prevLive: string | null,
  surfaces: readonly RightPanelSurface[],
  requested: string | null,
  write: LayoutWriteKind,
  view: WorkAreaView,
  origin: TabId | null,
): WorkAreaLayout {
  const byId = new Map<string, RightPanelSurface>(surfaces.map((surface) => [surface.id, surface]));
  const kindOf = (tab: TabId) => byId.get(tab)?.kind ?? null;
  const placed = surfacePayloadKinds(layout, surfaces);
  const placedSet = new Set(placed);
  const removed = placed.filter((tab) => !byId.has(tab));
  const added = surfaces.flatMap((surface) => {
    const tab = surfaceTabId(surface.id);
    return placedSet.has(tab) ? [] : [tab];
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
  let next = layout;
  let slot: TabId | null = null;
  const sourced = sourcePane(layout, write, origin) !== undefined;
  if (activated !== null && !sourced && added.includes(activated) && removed.length > 0) {
    const candidate = removed.find((tab) => tab === prevLive) ?? removed[0]!;
    const pane = paneHolding(next.root, candidate)!;
    const tabs = pane.tabs.map((tab) => (tab === candidate ? activated : tab));
    if ((pane.active === candidate || !isChatTab(next, pane.active)) && isNonEmpty(tabs)) {
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
    if (tab !== activated) next = placeInBackground(next, tab, kindOf(tab));
  }
  if (activated === null) return next;
  if (slot !== null) {
    const pane = paneHolding(next.root, activated)!;
    if (write === "automatic") return next;
    next = { ...setPane(next, { ...pane, active: activated }), focused: pane.id };
  } else if (added.includes(activated)) {
    const from = sourcePane(next, write, origin);
    next = from
      ? placeBeside(next, activated, from.id, view)
      : placeNew(next, activated, kindOf(activated), write, view);
  } else {
    next = showPlaced(next, activated, kindOf(activated), write, view);
  }
  return write === "automatic" ? next : withoutArmed(next);
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
    const valid = payload === undefined || payload.kind === "surface" ? surfaceIds.has(tab) : true;
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
  for (const surface of surfaces) {
    const tab = surfaceTabId(surface.id);
    if (!seen.has(tab) && !paneHolding(next.root, tab)) {
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
  return layoutEqual(next, layout) ? layout : next;
}

function chatTabsIn(layout: WorkAreaLayout, payloads: WorkAreaLayout["tabs"]): TabId[] {
  return leaves(layout.root).flatMap((pane) =>
    pane.tabs.filter((tab) => {
      const kind = (payloads[tab] ?? layout.tabs[tab])?.kind;
      return kind === "primary-chat" || kind === "secondary-chat";
    }),
  );
}

function withMirrors(
  next: ThreadRightPanelState,
  surfaces: RightPanelSurface[],
  layout: WorkAreaLayout,
): ThreadRightPanelState {
  const stored = isDefaultLayout(layout) ? undefined : layout;
  const focused = findPane(layout.root, layout.focused);
  const activeSurfaceId =
    focused !== undefined && surfaces.some((surface) => surface.id === focused.active)
      ? focused.active
      : null;
  const isOpen = surfaces.length > 0;
  if (
    next.surfaces === surfaces &&
    next.isOpen === isOpen &&
    next.activeSurfaceId === activeSurfaceId &&
    next.workArea === stored &&
    next.maximized === undefined
  ) {
    return next;
  }
  const { maximized: _maximized, workArea: _workArea, ...rest } = next;
  return { ...rest, surfaces, isOpen, activeSurfaceId, ...(stored ? { workArea: stored } : {}) };
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
  origin: TabId | null = null,
): ThreadRightPanelState {
  const surfaces = next.surfaces.some((surface) => surface.kind === "chat")
    ? next.surfaces.filter((surface) => surface.kind !== "chat")
    : next.surfaces;
  const layout =
    next.workArea !== prev.workArea
      ? (next.workArea ?? DEFAULT_LAYOUT)
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
  return withMirrors(next, surfaces, repairWorkArea(layout, surfaces));
}

// Unique across layouts and reloads, so a link captured from a closed Chat never matches its successor.
let lastPlacement = Date.now();

const sameThread = (left: ScopedThreadRef, right: ScopedThreadRef) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;

function place(
  layout: WorkAreaLayout,
  change: Extract<WorkAreaChange, { type: "place" }>,
  owner: ScopedThreadRef,
): WorkAreaLayout {
  let next = layout;
  const ids: TabId[] = [];
  if ("threads" in change.source) {
    for (const thread of change.source.threads) {
      if (sameThread(thread, owner)) {
        next = withPayload(next, PRIMARY_CHAT, next.tabs[PRIMARY_CHAT] ?? PRIMARY_PAYLOAD);
        ids.push(PRIMARY_CHAT);
        continue;
      }
      const tab = secondaryChatTabId(thread);
      if (next.tabs[tab] === undefined) {
        next = withPayload(next, tab, {
          kind: "secondary-chat",
          thread: scopeThreadRef(thread.environmentId, thread.threadId),
          placement: (lastPlacement += 1),
        });
      }
      ids.push(tab);
    }
  } else {
    ids.push(...change.source.tabs.filter((tab) => next.tabs[tab] !== undefined));
  }
  const moving = [...new Set(ids)];
  const { at } = change;
  const target =
    (at.kind === "strip" && at.before !== null ? paneHolding(next.root, at.before) : undefined) ??
    findPane(next.root, at.pane);
  if (!isNonEmpty(moving) || !target) return layout;
  const movingSet = new Set(moving);
  const remaining = target.tabs.filter((tab) => !movingSet.has(tab));
  next = removeTabs(next, movingSet, {
    keep: target.id,
    ...(change.restore === undefined ? {} : { restore: change.restore }),
  });
  if (at.kind === "edge") {
    if (!isNonEmpty(remaining)) return layout;
    const active =
      change.restore !== undefined && remaining.includes(change.restore)
        ? change.restore
        : remaining.includes(target.active)
          ? target.active
          : remaining[Math.min(target.tabs.indexOf(target.active), remaining.length - 1)]!;
    next = setPane(next, { ...target, tabs: remaining, active });
    const split = splitPane(next, target.id, at.edge, moving);
    return withoutArmed({ ...split.layout, focused: split.pane });
  }
  const before = at.kind === "strip" ? at.before : null;
  return withoutArmed({
    ...setPane(next, insertTabs(target, moving, before, true)),
    focused: target.id,
  });
}

/** `updateWorkArea`'s reducer. The write path then repairs the result and writes the mirrors. */
export function applyWorkAreaChange(
  layout: WorkAreaLayout,
  change: WorkAreaChange,
  owner: ScopedThreadRef,
  view: WorkAreaView,
  origin: TabId | null = null,
): WorkAreaLayout {
  switch (change.type) {
    case "place":
      return place(layout, change, owner);
    case "close": {
      const payload = layout.tabs[change.tab];
      if (payload === undefined || payload.kind === "surface") return layout;
      if (payload.kind !== "linked-file" && chatTabs(layout).length <= 1) return layout;
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
    case "focus":
      if (!findPane(layout.root, change.pane)) return layout;
      return withoutArmed(
        layout.focused === change.pane ? layout : { ...layout, focused: change.pane },
      );
    case "ratio": {
      const ratio = clampRatio(change.ratio);
      const root = mapSplits(layout.root, (split) =>
        split.id === change.split && split.ratio !== ratio ? { ...split, ratio } : split,
      );
      return root === layout.root ? layout : { ...layout, root };
    }
    case "arm":
      if (!findPane(layout.root, change.pane)) return layout;
      return { ...layout, armed: { pane: change.pane, kind: change.kind } };
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
      const source = sourcePane(next, "user", origin);
      const shown = paneHolding(next.root, tab)
        ? showPlaced(next, tab, "file", "user", view)
        : source
          ? placeBeside(next, tab, source.id, view)
          : placeNew(next, tab, "file", "user", view);
      return withoutArmed(shown);
    }
  }
}
