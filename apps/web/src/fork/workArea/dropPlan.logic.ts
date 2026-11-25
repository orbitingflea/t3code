import {
  type Edge,
  holders,
  type LayoutNode,
  leaves,
  type PaneId,
  type TabId,
} from "./workArea.logic";
import type { Placement } from "./workAreaPlacement.logic";

/** Viewport pixels, measured from the DOM when the pointer moves. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PaneGeometry {
  readonly id: PaneId;
  readonly frame: Box;
  readonly strip: Box;
  /** Strip tabs, left to right. */
  readonly tabs: readonly { readonly id: TabId; readonly box: Box }[];
}

export type DragSubject =
  | { readonly kind: "tab"; readonly tab: TabId; readonly from: PaneId; readonly copy?: true }
  | { readonly kind: "outside" };

export type DropGhost =
  | {
      readonly kind: "box";
      readonly left: number;
      readonly top: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "marker";
      readonly left: number;
      readonly top: number;
      readonly height: number;
    };

export interface DropPlan {
  readonly at: Placement;
  readonly ghost: DropGhost;
}

const MARKER_WIDTH = 2;
/** Within this share of a body's edge the drop splits; the middle joins. */
const EDGE_SHARE = 0.25;

const contains = (box: Box, x: number, y: number) =>
  x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

const boxGhost = (box: Box): DropGhost => ({
  kind: "box",
  left: box.left,
  top: box.top,
  width: box.right - box.left,
  height: box.bottom - box.top,
});

/**
 * Where the subject lands after joining a pane, or after splitting it on an edge; null when the
 * result does not fit. An edge's ghost is that box.
 */
export type DropFits = (pane: PaneId, at: "join" | Edge) => Box | null;

function stripPlan(
  pane: PaneGeometry,
  x: number,
  subject: DragSubject,
  fits: DropFits,
): DropPlan | null {
  const index = pane.tabs.findIndex(({ box }) => x < (box.left + box.right) / 2);
  const before = index < 0 ? null : pane.tabs[index]!.id;
  if (subject.kind === "tab" && subject.from === pane.id) {
    const own = pane.tabs.findIndex(({ id }) => id === subject.tab);
    const next = pane.tabs[own + 1]?.id ?? null;
    if (before === subject.tab || before === next) return null;
  }
  if (fits(pane.id, "join") === null) return null;
  const anchor = index < 0 ? pane.tabs.at(-1)?.box : pane.tabs[index]!.box;
  const left = anchor ? (index < 0 ? anchor.right : anchor.left) : pane.strip.left;
  return {
    at: { kind: "strip", pane: pane.id, before },
    ghost: {
      kind: "marker",
      left: left - MARKER_WIDTH / 2,
      top: anchor?.top ?? pane.strip.top,
      height: (anchor?.bottom ?? pane.strip.bottom) - (anchor?.top ?? pane.strip.top),
    },
  };
}

/**
 * What a drop at `point` would do: over a strip, insert before the tab under the pointer (or at the
 * end); over a body, split on the nearest edge when that fits, else join. A drop that would change
 * nothing, or that does not fit, is null, so no ghost promises it.
 */
export function planDrop(
  panes: readonly PaneGeometry[],
  point: { readonly x: number; readonly y: number },
  subject: DragSubject,
  fits: DropFits,
): DropPlan | null {
  const pane = panes.find((candidate) => contains(candidate.frame, point.x, point.y));
  if (!pane) return null;
  if (contains(pane.strip, point.x, point.y)) return stripPlan(pane, point.x, subject, fits);
  const own = subject.kind === "tab" && subject.from === pane.id;
  const body: Box = { ...pane.frame, top: pane.strip.bottom };
  const width = body.right - body.left;
  const height = body.bottom - body.top;
  if (width <= 0 || height <= 0) return null;
  const fx = (point.x - body.left) / width;
  const fy = (point.y - body.top) / height;
  const [edge, distance] = (
    [
      ["left", fx],
      ["right", 1 - fx],
      ["top", fy],
      ["bottom", 1 - fy],
    ] as const
  ).reduce((nearest, entry) => (entry[1] < nearest[1] ? entry : nearest));
  const landing = distance < EDGE_SHARE ? fits(pane.id, edge) : null;
  if (landing !== null) {
    // A copy of a lone tab may split its own pane; a move would leave the pane empty.
    if (own && pane.tabs.length <= 1 && subject.copy !== true) return null;
    return { at: { kind: "edge", pane: pane.id, edge }, ghost: boxGhost(landing) };
  }
  if (own || fits(pane.id, "join") === null) return null;
  return { at: { kind: "join", pane: pane.id }, ghost: boxGhost(pane.frame) };
}

/**
 * The one-strip view lists every pane's tabs in order, so a strip drop goes before its tab in that
 * tab's pane, and a drop at the end goes after the last pane's tabs.
 */
export function inStripView(plan: DropPlan | null, root: LayoutNode): DropPlan | null {
  if (plan?.at.kind !== "strip") return plan;
  // The strip draws a tab where it first occurs in leaf order.
  const pane = plan.at.before === null ? leaves(root).at(-1) : holders(root, plan.at.before)[0];
  return pane ? { ...plan, at: { ...plan.at, pane: pane.id } } : null;
}

export function samePlan(left: DropPlan | null, right: DropPlan | null): boolean {
  if (left === null || right === null) return left === right;
  const a = left.at;
  const b = right.at;
  const sameAt =
    a.kind === b.kind &&
    a.pane === b.pane &&
    (a.kind !== "strip" || (b.kind === "strip" && a.before === b.before)) &&
    (a.kind !== "edge" || (b.kind === "edge" && a.edge === b.edge));
  return (
    sameAt &&
    left.ghost.kind === right.ghost.kind &&
    left.ghost.left === right.ghost.left &&
    left.ghost.top === right.ghost.top &&
    left.ghost.height === right.ghost.height &&
    (left.ghost.kind !== "box" ||
      (right.ghost.kind === "box" && left.ghost.width === right.ghost.width))
  );
}
