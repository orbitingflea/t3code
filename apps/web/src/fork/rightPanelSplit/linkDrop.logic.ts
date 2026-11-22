import {
  boxGhost,
  type DropGhost,
  markerGhost,
  type Rect,
  splitGhost,
  splitSideAt,
} from "./dropTarget.logic";
import {
  applySplitChange,
  paneLayout,
  paneOf,
  type PaneSide,
  type PanelArrangement,
  type SplitChange,
} from "./splitLayout.logic";

/**
 * One rendered pane, measured from the DOM. A single strip is "left". `tabs` are the tabs
 * visible in the strip, in strip order.
 */
export interface PaneGeometry {
  readonly side: PaneSide;
  /** The whole tab bar row, layout controls included. */
  readonly strip: Rect;
  readonly content: Rect;
  readonly tabs: readonly { readonly id: string; readonly rect: Rect }[];
}

/** Where the surface a dropped link opens must end up; its id is not known before the open. */
export type LinkPlacement =
  | { readonly kind: "open" }
  | { readonly kind: "pane"; readonly pane: PaneSide }
  | { readonly kind: "slot"; readonly pane: PaneSide; readonly beforeId: string | null }
  | { readonly kind: "split"; readonly side: PaneSide };

export interface LinkDropPlan {
  readonly placement: LinkPlacement;
  readonly ghost: DropGhost;
}

export interface LinkDropInput {
  readonly arrangement: PanelArrangement;
  /** Two strips are on screen; a stored split can be hidden on a narrow panel. */
  readonly splitRendered: boolean;
  readonly splitAllowed: boolean;
  readonly splitGrowth: number;
  readonly panes: readonly PaneGeometry[];
  readonly pointer: { readonly x: number; readonly y: number };
}

const EMPTY_STRIP_INSET = 8;

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function stripOf(arrangement: PanelArrangement, pane: PaneSide, splitRendered: boolean) {
  return splitRendered
    ? arrangement.surfaces.filter((surface) => paneOf(arrangement, surface.id) === pane)
    : arrangement.surfaces;
}

function slotPlan(input: LinkDropInput, pane: PaneGeometry): LinkDropPlan {
  const { arrangement, pointer, splitRendered } = input;
  const strip = stripOf(arrangement, pane.side, splitRendered);
  // A hidden split shows one strip; a slot belongs to the stored pane of the tab beside it.
  const paneFor = (neighbourId: string | undefined): PaneSide =>
    splitRendered || neighbourId === undefined ? pane.side : paneOf(arrangement, neighbourId);
  const nearest =
    pane.tabs.find((tab) => pointer.x >= tab.rect.left && pointer.x <= tab.rect.right) ??
    pane.tabs.reduce<PaneGeometry["tabs"][number] | undefined>((best, tab) => {
      const centre = (rect: Rect) => Math.abs(pointer.x - (rect.left + rect.right) / 2);
      return best === undefined || centre(tab.rect) < centre(best.rect) ? tab : best;
    }, undefined);
  if (nearest === undefined) {
    return {
      placement: { kind: "slot", pane: paneFor(strip.at(-1)?.id), beforeId: null },
      ghost: markerGhost({ ...pane.strip, right: pane.strip.left + EMPTY_STRIP_INSET }, true),
    };
  }
  const after = pointer.x >= (nearest.rect.left + nearest.rect.right) / 2;
  const index = strip.findIndex((surface) => surface.id === nearest.id);
  const beforeId = after ? (index < 0 ? null : (strip[index + 1]?.id ?? null)) : nearest.id;
  return {
    placement: { kind: "slot", pane: paneFor(nearest.id), beforeId },
    ghost: markerGhost(nearest.rect, after),
  };
}

/**
 * What a link dropped at the pointer would do, or null off every pane. A strip gives a slot by
 * the nearest visible tab's half. A rendered split's content gives that pane. One pane's
 * content gives a split in its outer thirds when a split can start, else just an open.
 */
export function planLinkDrop(input: LinkDropInput): LinkDropPlan | null {
  const { x, y } = input.pointer;
  const pane = input.panes.find(
    (entry) => contains(entry.strip, x, y) || contains(entry.content, x, y),
  );
  if (pane === undefined) return null;
  if (contains(pane.strip, x, y)) return slotPlan(input, pane);
  if (input.splitRendered) {
    return { placement: { kind: "pane", pane: pane.side }, ghost: boxGhost(pane.content) };
  }
  const canSplit =
    input.splitAllowed &&
    input.arrangement.split === undefined &&
    input.arrangement.surfaces.length > 0;
  const side = canSplit ? splitSideAt(pane.content, x) : null;
  return side === null
    ? { placement: { kind: "open" }, ghost: boxGhost(pane.content) }
    : {
        placement: { kind: "split", side },
        ghost: splitGhost(pane.content, side, input.splitGrowth),
      };
}

/** What the pane `surfaceId` leaves showed at drop time: the pane it was in, else the focused one. */
function shownBefore(before: PanelArrangement, surfaceId: string): string | null {
  const layout = paneLayout(before);
  if (layout.kind === "single") return before.activeSurfaceId;
  const existed = before.surfaces.some((surface) => surface.id === surfaceId);
  return layout[existed ? paneOf(before, surfaceId) : layout.focused].shown.id;
}

function successorOf(arrangement: PanelArrangement, pane: PaneSide, surfaceId: string) {
  const strip = stripOf(arrangement, pane, arrangement.split !== undefined);
  const index = strip.findIndex((surface) => surface.id === surfaceId);
  return index < 0 ? null : (strip[index + 1]?.id ?? null);
}

function changeFor(
  after: PanelArrangement,
  surfaceId: string,
  placement: LinkPlacement,
  restore: { restoreShown?: string },
): SplitChange | null {
  switch (placement.kind) {
    case "open":
      return null;
    case "pane":
      return after.split === undefined || paneOf(after, surfaceId) === placement.pane
        ? null
        : { type: "move", surfaceId, pane: placement.pane, beforeId: null, ...restore };
    case "slot": {
      const beforeId =
        placement.beforeId === surfaceId
          ? successorOf(after, placement.pane, surfaceId)
          : placement.beforeId;
      return after.split === undefined
        ? { type: "reorder", surfaceId, beforeId }
        : { type: "move", surfaceId, pane: placement.pane, beforeId, ...restore };
    }
    case "split":
      if (after.split === undefined) {
        return { type: "split", surfaceId, side: placement.side, ...restore };
      }
      return paneOf(after, surfaceId) === placement.side
        ? null
        : { type: "move", surfaceId, pane: placement.side, beforeId: null, ...restore };
  }
}

/**
 * The change that puts `surfaceId`, which the dropped link's open just activated, where the
 * drop said. `before` is the arrangement at drop time, `after` the one the open left. Null when
 * the open already left it there. Ids, not indices: a stale change degrades to a no-op.
 */
export function placementChange(
  before: PanelArrangement,
  after: PanelArrangement,
  surfaceId: string,
  placement: LinkPlacement,
): SplitChange | null {
  if (!after.surfaces.some((surface) => surface.id === surfaceId)) return null;
  const shown = shownBefore(before, surfaceId);
  const restore = shown === null || shown === surfaceId ? {} : { restoreShown: shown };
  const change = changeFor(after, surfaceId, placement, restore);
  return change === null || applySplitChange(after, change) === after ? null : change;
}

/**
 * The first of copy, link and move that the source's `effectAllowed` permits; a `dropEffect`
 * outside it makes the browser refuse the drop.
 */
export function dropEffectFor(effectAllowed: string): "copy" | "link" | "move" | null {
  if (effectAllowed === "none") return null;
  if (effectAllowed === "all" || effectAllowed === "uninitialized") return "copy";
  const allowed = effectAllowed.toLowerCase();
  return (["copy", "link", "move"] as const).find((effect) => allowed.includes(effect)) ?? null;
}
