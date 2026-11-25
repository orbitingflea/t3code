import type { RightPanelSurface, ThreadRightPanelState } from "~/rightPanelStore";

import {
  findPane,
  focusedTab,
  type LayoutNode,
  leaves,
  mapSplits,
  type PaneId,
  PRIMARY_CHAT,
  resolveLayout,
  type PaneNode,
  type SplitAxis,
  type SplitId,
  type SplitNode,
  type TabId,
  tabTraits,
  type WorkAreaLayout,
} from "./workArea.logic";

/** What a store write may know of the mounted work area. */
export interface WorkAreaView {
  readonly narrow: boolean;
  /** The work area's pixel size; null when none is mounted. */
  readonly size: { readonly width: number; readonly height: number } | null;
}

export const NO_VIEW: WorkAreaView = { narrow: false, size: null };

const PANE_MIN_WIDTH = 220;
const COMPOSER_PANE_MIN_WIDTH = 360;
const PANE_MIN_HEIGHT = 120;
const DIVIDER_SIZE = 1;
const RATIO_MIN = 0.15;
const RATIO_MAX = 0.85;

/** Fractions of the work area. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

function forEachRect(
  node: LayoutNode,
  rect: Rect,
  visit: (node: LayoutNode, rect: Rect) => void,
  override?: { readonly split: SplitId; readonly ratio: number },
): void {
  visit(node, rect);
  if (node.kind === "pane") return;
  const ratio = override?.split === node.id ? override.ratio : node.ratio;
  if (node.axis === "row") {
    forEachRect(node.first, { ...rect, w: rect.w * ratio }, visit, override);
    forEachRect(
      node.second,
      { ...rect, x: rect.x + rect.w * ratio, w: rect.w * (1 - ratio) },
      visit,
      override,
    );
  } else {
    forEachRect(node.first, { ...rect, h: rect.h * ratio }, visit, override);
    forEachRect(
      node.second,
      { ...rect, y: rect.y + rect.h * ratio, h: rect.h * (1 - ratio) },
      visit,
      override,
    );
  }
}

export function paneRects(
  root: LayoutNode,
  override?: { readonly split: SplitId; readonly ratio: number },
): Map<PaneId, Rect> {
  const rects = new Map<PaneId, Rect>();
  forEachRect(
    root,
    FULL,
    (node, rect) => {
      if (node.kind === "pane") rects.set(node.id, rect);
    },
    override,
  );
  return rects;
}

const FIT_TOLERANCE = 1;

/** Any tab with a message box, shown or not, needs the composer footer's width. */
const paneMinWidth = (layout: WorkAreaLayout, pane: PaneNode) =>
  pane.tabs.some((tab) => tabTraits(layout, tab).composer)
    ? COMPOSER_PANE_MIN_WIDTH
    : PANE_MIN_WIDTH;

function treeFits(
  layout: WorkAreaLayout,
  size: { readonly width: number; readonly height: number },
): boolean {
  const rects = paneRects(layout.root);
  return leaves(layout.root).every((pane) => {
    const rect = rects.get(pane.id)!;
    return (
      rect.w * size.width + FIT_TOLERANCE >= paneMinWidth(layout, pane) &&
      rect.h * size.height + FIT_TOLERANCE >= PANE_MIN_HEIGHT
    );
  });
}

/** One strip for every tab: a narrow window, or a saved tree that does not fit. */
export function isStripView(layout: WorkAreaLayout, view: WorkAreaView): boolean {
  return view.narrow || (view.size !== null && !treeFits(layout, view.size));
}

/**
 * The one fit check for drops, the tab menu and opens: every pane of `layout` keeps its minimum.
 * Null when no work area is mounted to measure.
 */
export function fitsView(layout: WorkAreaLayout, view: WorkAreaView): boolean | null {
  if (view.narrow) return false;
  if (view.size === null) return null;
  return treeFits(layout, view.size);
}

function minExtent(layout: WorkAreaLayout, node: LayoutNode, axis: SplitAxis): number {
  if (node.kind === "pane") {
    return axis === "row" ? paneMinWidth(layout, node) : PANE_MIN_HEIGHT;
  }
  const first = minExtent(layout, node.first, axis);
  const second = minExtent(layout, node.second, axis);
  return node.axis === axis
    ? Math.max(first / node.ratio, second / (1 - node.ratio))
    : Math.max(first, second);
}

export function clampRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio)) : 0.5;
}

type Factor = { readonly split: SplitId; readonly complement: boolean };
type Product = readonly Factor[];

/** A box in CSS: percentages of the work area, written with each split's ratio variable. */
export interface CssBox {
  readonly left: string;
  readonly top: string;
  readonly width: string;
  readonly height: string;
}

export const splitVariable = (split: SplitId) => `--work-area-${split}`;

const factorCss = (factor: Factor) =>
  factor.complement
    ? `(1 - var(${splitVariable(factor.split)}))`
    : `var(${splitVariable(factor.split)})`;
const productCss = (product: Product) =>
  product.length === 0 ? "1" : product.map(factorCss).join(" * ");
const offsetCss = (sum: readonly Product[]) =>
  sum.length === 0 ? "0%" : `calc((${sum.map(productCss).join(" + ")}) * 100%)`;
const extentCss = (product: Product) =>
  product.length === 0 ? "100%" : `calc(${productCss(product)} * 100%)`;

interface Symbolic {
  readonly x: readonly Product[];
  readonly y: readonly Product[];
  readonly w: Product;
  readonly h: Product;
}

export interface PaneEdges {
  readonly top: boolean;
  readonly left: boolean;
  readonly right: boolean;
  readonly bottom: boolean;
}

const ALL_EDGES: PaneEdges = { top: true, left: true, right: true, bottom: true };

export interface DrawnPane {
  readonly id: PaneId;
  /** Strip order; one strip lists every pane's tabs. */
  readonly tabs: readonly TabId[];
  readonly active: TabId;
  readonly focused: boolean;
  readonly edges: PaneEdges;
  readonly rect: Rect;
  readonly box: CssBox;
}

export interface DrawnDivider {
  readonly split: SplitNode;
  /** The split's own box, as fractions. */
  readonly parent: Rect;
  readonly box: CssBox;
}

interface DrawnWorkArea {
  readonly strip: boolean;
  readonly panes: readonly DrawnPane[];
  readonly dividers: readonly DrawnDivider[];
}

export function drawWorkArea(layout: WorkAreaLayout, view: WorkAreaView): DrawnWorkArea {
  const panes: DrawnPane[] = [];
  const dividers: DrawnDivider[] = [];
  if (isStripView(layout, view)) {
    const focused = findPane(layout.root, layout.focused) ?? leaves(layout.root)[0]!;
    const tabs = [...new Set(leaves(layout.root).flatMap((pane) => pane.tabs))];
    panes.push({
      id: focused.id,
      tabs,
      active: focused.active,
      focused: true,
      edges: ALL_EDGES,
      rect: FULL,
      box: { left: "0%", top: "0%", width: "100%", height: "100%" },
    });
    return { strip: true, panes, dividers };
  }
  const walk = (node: LayoutNode, sym: Symbolic, rect: Rect, edges: PaneEdges) => {
    if (node.kind === "pane") {
      panes.push({
        id: node.id,
        tabs: node.tabs,
        active: node.active,
        focused: node.id === layout.focused,
        edges,
        rect,
        box: {
          left: offsetCss(sym.x),
          top: offsetCss(sym.y),
          width: extentCss(sym.w),
          height: extentCss(sym.h),
        },
      });
      return;
    }
    const ratio: Factor = { split: node.id, complement: false };
    const rest: Factor = { split: node.id, complement: true };
    if (node.axis === "row") {
      const offset = [...sym.x, [...sym.w, ratio]];
      dividers.push({
        split: node,
        parent: rect,
        box: {
          left: offsetCss(offset),
          top: offsetCss(sym.y),
          width: `${DIVIDER_SIZE}px`,
          height: extentCss(sym.h),
        },
      });
      walk(
        node.first,
        { ...sym, w: [...sym.w, ratio] },
        { ...rect, w: rect.w * node.ratio },
        {
          ...edges,
          right: false,
        },
      );
      walk(
        node.second,
        { ...sym, x: offset, w: [...sym.w, rest] },
        { ...rect, x: rect.x + rect.w * node.ratio, w: rect.w * (1 - node.ratio) },
        { ...edges, left: false },
      );
    } else {
      const offset = [...sym.y, [...sym.h, ratio]];
      dividers.push({
        split: node,
        parent: rect,
        box: {
          left: offsetCss(sym.x),
          top: offsetCss(offset),
          width: extentCss(sym.w),
          height: `${DIVIDER_SIZE}px`,
        },
      });
      walk(
        node.first,
        { ...sym, h: [...sym.h, ratio] },
        { ...rect, h: rect.h * node.ratio },
        {
          ...edges,
          bottom: false,
        },
      );
      walk(
        node.second,
        { ...sym, y: offset, h: [...sym.h, rest] },
        { ...rect, y: rect.y + rect.h * node.ratio, h: rect.h * (1 - node.ratio) },
        { ...edges, top: false },
      );
    }
  };
  walk(layout.root, { x: [], y: [], w: [], h: [] }, FULL, ALL_EDGES);
  return { strip: false, panes, dividers };
}

/** Each split's ratio, as the CSS variables the drawn boxes read. */
export function splitVariables(root: LayoutNode): Record<string, string> {
  const variables: Record<string, string> = {};
  mapSplits(root, (split) => {
    variables[splitVariable(split.id)] = String(split.ratio);
    return split;
  });
  return variables;
}

/** The ratio range that keeps both sides of a divider at their minimum, for this work-area size. */
export function ratioBounds(
  layout: WorkAreaLayout,
  divider: Pick<DrawnDivider, "split" | "parent">,
  size: { readonly width: number; readonly height: number },
): { readonly min: number; readonly max: number } {
  const { axis, first, second } = divider.split;
  const total = axis === "row" ? divider.parent.w * size.width : divider.parent.h * size.height;
  if (total <= 0) return { min: RATIO_MIN, max: RATIO_MAX };
  return {
    min: Math.max(RATIO_MIN, minExtent(layout, first, axis) / total),
    max: Math.min(RATIO_MAX, 1 - (minExtent(layout, second, axis) + DIVIDER_SIZE) / total),
  };
}

function dividerOf(
  layout: WorkAreaLayout,
  id: SplitId,
): Pick<DrawnDivider, "split" | "parent"> | undefined {
  const found: Pick<DrawnDivider, "split" | "parent">[] = [];
  forEachRect(layout.root, FULL, (node, parent) => {
    if (node.kind === "split" && node.id === id) found.push({ split: node, parent });
  });
  return found[0];
}

/**
 * `ratio` for split `id`, moved into the range that keeps both sides at their minimum at this size;
 * null when no ratio does.
 */
export function fittedRatio(
  layout: WorkAreaLayout,
  id: SplitId,
  ratio: number,
  view: WorkAreaView,
): number | null {
  const divider = view.size === null ? undefined : dividerOf(layout, id);
  if (view.size === null || divider === undefined) return clampRatio(ratio);
  const bounds = ratioBounds(layout, divider, view.size);
  if (bounds.min > bounds.max) return null;
  return Math.min(bounds.max, Math.max(bounds.min, ratio));
}

/**
 * A split's ratio, moved just far enough that both sides keep their minimum at this size. When no
 * ratio does, the one that fits at the smallest size, so the panes come back once there is room.
 */
export function settleSplit(
  layout: WorkAreaLayout,
  id: SplitId,
  view: WorkAreaView,
): WorkAreaLayout {
  const split = view.size === null ? undefined : dividerOf(layout, id)?.split;
  if (split === undefined) return layout;
  const first = minExtent(layout, split.first, split.axis);
  const second = minExtent(layout, split.second, split.axis) + DIVIDER_SIZE;
  const ratio = fittedRatio(layout, id, split.ratio, view) ?? clampRatio(first / (first + second));
  if (ratio === split.ratio) return layout;
  const root = mapSplits(layout.root, (node) => (node.id === id ? { ...node, ratio } : node));
  return { ...layout, root };
}

/** The splits from the root down to `pane`; empty when `pane` is not in the tree. */
export function splitsAbove(root: LayoutNode, pane: PaneId): SplitId[] {
  if (root.kind === "pane") return [];
  for (const side of [root.first, root.second]) {
    const below = splitsAbove(side, pane);
    if (below.length > 0 || (side.kind === "pane" && side.id === pane)) return [root.id, ...below];
  }
  return [];
}

/** Settles every split above `pane`, outermost first, so the pane gets its minimum when it can. */
export function settleAround(
  layout: WorkAreaLayout,
  pane: PaneId,
  view: WorkAreaView,
): WorkAreaLayout {
  return splitsAbove(layout.root, pane).reduce(
    (settled, split) => settleSplit(settled, split, view),
    layout,
  );
}

/**
 * Settles `splits`, innermost first, for when no ratio may fit now: each outer split then counts
 * the inner ratios it keeps.
 */
export function settleInnermostFirst(
  layout: WorkAreaLayout,
  splits: ReadonlySet<SplitId>,
  view: WorkAreaView,
): WorkAreaLayout {
  const depths: [SplitId, number][] = [];
  const walk = (node: LayoutNode, depth: number) => {
    if (node.kind === "pane") return;
    if (splits.has(node.id)) depths.push([node.id, depth]);
    walk(node.first, depth + 1);
    walk(node.second, depth + 1);
  };
  walk(layout.root, 0);
  return depths
    .toSorted((a, b) => b[1] - a[1])
    .reduce((settled, [split]) => settleSplit(settled, split, view), layout);
}

/**
 * Whether `tab` is on screen: the active tab of a drawn pane (restricted to `pane` when given in
 * split view), or the focused tab in strip view.
 */
export function tabShown(
  layout: WorkAreaLayout,
  view: WorkAreaView,
  tab: TabId,
  pane?: PaneId,
): boolean {
  // The one strip shows tabs, so there any view of the tab counts.
  return isStripView(layout, view)
    ? focusedTab(layout) === tab
    : leaves(layout.root).some(
        (candidate) => candidate.active === tab && (pane === undefined || candidate.id === pane),
      );
}

/** The surfaces the user can see now: the active surface of each drawn pane. */
export function shownSurfaces(
  record: ThreadRightPanelState,
  view: WorkAreaView,
): RightPanelSurface[] {
  const layout = resolveLayout(record);
  const panes = isStripView(layout, view)
    ? [findPane(layout.root, layout.focused) ?? leaves(layout.root)[0]!]
    : leaves(layout.root);
  return panes.flatMap(
    (pane) => record.surfaces.find((surface) => surface.id === pane.active) ?? [],
  );
}

/**
 * The primary chat column's box when a drawn pane shows the primary Chat, else null. `override` is a
 * divider drag's ratio before it commits.
 */
export function primaryChatRect(
  layout: WorkAreaLayout,
  view: WorkAreaView,
  override?: { readonly split: SplitId; readonly ratio: number },
): Rect | null {
  if (isStripView(layout, view)) {
    const focused = findPane(layout.root, layout.focused) ?? leaves(layout.root)[0]!;
    return focused.active === PRIMARY_CHAT ? FULL : null;
  }
  const pane = leaves(layout.root).find((candidate) => candidate.active === PRIMARY_CHAT);
  return pane ? (paneRects(layout.root, override).get(pane.id) ?? null) : null;
}

/** The chat column over a pane's body: the pane's box less its strip. */
export function chatColumnBox(rect: Rect): CssBox {
  const percent = (fraction: number) => `${fraction * 100}%`;
  return {
    left: percent(rect.x),
    top: `calc(${percent(rect.y)} + var(--workspace-topbar-height))`,
    width: percent(rect.w),
    height: `calc(${percent(rect.h)} - var(--workspace-topbar-height))`,
  };
}
