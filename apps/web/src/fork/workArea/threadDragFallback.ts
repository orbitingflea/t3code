import type { ScopedThreadRef } from "@t3tools/contracts";

type Point = { readonly x: number; readonly y: number };

/** Where a thread drag lands when no composer is under the point: the mounted work area. */
interface ThreadDragFallback {
  readonly move: (point: Point | null) => void;
  readonly drop: (point: Point, threads: ReadonlyArray<ScopedThreadRef>) => boolean;
  readonly end: () => void;
}

let fallback: ThreadDragFallback | null = null;

export function registerThreadDragFallback(next: ThreadDragFallback): () => void {
  fallback = next;
  return () => {
    if (fallback === next) fallback = null;
  };
}

/** The work area's view of a thread drag; `point` is null while a composer is under the pointer. */
export function moveThreadDragFallback(point: Point | null): void {
  fallback?.move(point);
}

export function endThreadDragFallback(): void {
  fallback?.end();
}

export function dropOnThreadDragFallback(
  point: Point,
  threads: ReadonlyArray<ScopedThreadRef>,
): boolean {
  return fallback?.drop(point, threads) ?? false;
}

/** A drag shield covers the page while it is up; composers under it stay drop targets. */
const DRAG_SHIELD_ATTRIBUTE = "data-drag-shield";

export function dragShieldProps() {
  return { [DRAG_SHIELD_ATTRIBUTE]: "true" } as const;
}

export function elementFromPointUnderShield(point: Point): Element | undefined {
  return document
    .elementsFromPoint(point.x, point.y)
    .find((element) => !element.hasAttribute(DRAG_SHIELD_ATTRIBUTE));
}
