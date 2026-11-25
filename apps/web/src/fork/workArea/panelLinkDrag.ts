import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext, useSyncExternalStore } from "react";

import "./panelLinkDrag.css";

/** Marks a drag as a panel link; a dragover can read only `types`, never the data. */
const PANEL_LINK_DRAG_TYPE = "application/x-t3code-panel-link";

/** A dragged link that can open in `panelRef`'s right panel. */
export interface PanelLink {
  readonly panelRef: ScopedThreadRef;
  readonly open: () => void | Promise<unknown>;
  /** True when the opened tab has a message box and needs a wide pane. */
  readonly composer?: boolean;
}

// The work area a Files tree row drops into (`ref`), and how the dropped row opens there.
export interface PanelLinkOwner {
  readonly ref: ScopedThreadRef;
  readonly openFile: (path: string) => void;
}

/** Drop target and opener for a Files tree. Provided by `WorkArea` and `LinkedFileBody`. */
export const PanelLinkOwnerContext = createContext<PanelLinkOwner | null>(null);

export function usePanelLinkOwner(): PanelLinkOwner | null {
  return useContext(PanelLinkOwnerContext);
}

interface DragStart {
  readonly dataTransfer: DataTransfer | null;
  preventDefault(): void;
}

interface Entry {
  readonly token: number;
  readonly panelKey: string;
  readonly link: PanelLink;
  /** A dragover carrying the marker reached this document, so the drag start is over. */
  armed: boolean;
  // Runs once the drag ends, however it ends: its source may be gone by then.
  readonly onEnd: (() => void) | undefined;
}

// The open is a closure, so it cannot ride in `dataTransfer`; one drag runs at a time.
let entry: Entry | null = null;
let nextToken = 0;
const subscribers = new Set<() => void>();

const notify = () => {
  for (const subscriber of subscribers) subscriber();
};

/** Marks the document while a link drag is past its start; `panelLinkDrag.css` reads it. */
function markArmed(armed: boolean) {
  document.documentElement.toggleAttribute("data-panel-link-drag", armed);
}

const onDragOver = (event: DragEvent) => {
  if (entry === null || entry.armed) return;
  if (!event.dataTransfer?.types.includes(PANEL_LINK_DRAG_TYPE)) return;
  entry.armed = true;
  markArmed(true);
  notify();
};

// Deferred: the window sees a drop before the panel does, and the panel must still claim it.
const onDragFinished = () => {
  const token = entry?.token;
  if (token !== undefined) setTimeout(() => clear(token), 0);
};

// A running drag fires no pointer events, so one means the drag ended without a dragend here.
const onPointer = () => clear();

const LISTENERS = [
  ["dragenter", onDragOver],
  ["dragover", onDragOver],
  ["drop", onDragFinished],
  ["dragend", onDragFinished],
  ["pointerdown", onPointer],
  ["pointermove", onPointer],
] as const;

function listen(on: boolean) {
  for (const [type, listener] of LISTENERS) {
    if (on) window.addEventListener(type, listener as EventListener, true);
    else window.removeEventListener(type, listener as EventListener, true);
  }
}

function clear(token?: number) {
  if (entry === null || (token !== undefined && entry.token !== token)) return;
  const { onEnd } = entry;
  entry = null;
  listen(false);
  markArmed(false);
  notify();
  onEnd?.();
}

/**
 * Call from a source's `dragstart`. Keeps the data the source set, so other drop targets are
 * unchanged. Optional `onEnd` runs once when the drag ends, however it ends, even if the source
 * element is gone.
 */
export function startPanelLinkDrag(
  event: DragStart,
  link: PanelLink | null,
  onEnd?: () => void,
): void {
  clear();
  if (link === null || event.dataTransfer === null) return;
  event.dataTransfer.setData(PANEL_LINK_DRAG_TYPE, "1");
  entry = {
    token: ++nextToken,
    panelKey: scopedThreadKey(link.panelRef),
    link,
    armed: false,
    onEnd,
  };
  listen(true);
}

/**
 * For a chip whose only drag meaning is the panel: drops the data the browser added (a router
 * link's URL) and carries only the marker; a null `link` cancels the drag. Optional `onEnd` runs
 * once when the drag ends, however it ends, even if the source element is gone.
 */
export function startPanelOnlyDrag(
  event: DragStart,
  link: PanelLink | null,
  onEnd?: () => void,
): void {
  if (link === null || event.dataTransfer === null) {
    clear();
    event.preventDefault();
    return;
  }
  event.dataTransfer.clearData();
  startPanelLinkDrag(event, link, onEnd);
}

/**
 * Returns drag props for an element that drags only to the panel. Runs `build` on `dragstart`.
 * Optional `onEnd` runs once when the drag ends, however it ends, even if the element is gone.
 */
export const panelDragProps = (build: () => PanelLink | null, onEnd?: () => void) => ({
  draggable: true,
  onDragStart: (event: DragStart) => startPanelOnlyDrag(event, build(), onEnd),
});

function subscribe(subscriber: () => void) {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

/** The dragged link for `panelRef` once the drag is past its start, or null. */
export function useOwnedPanelLinkDrag(panelRef: ScopedThreadRef): PanelLink | null {
  const panelKey = scopedThreadKey(panelRef);
  return useSyncExternalStore(subscribe, () =>
    entry !== null && entry.armed && entry.panelKey === panelKey ? entry.link : null,
  );
}

/** The dropped link when it opens in `panelRef`'s panel, else null. Call inside the drop event. */
export function claimPanelLinkDrop(
  panelRef: ScopedThreadRef,
  dataTransfer: DataTransfer | null,
): PanelLink | null {
  if (entry === null || !dataTransfer?.types.includes(PANEL_LINK_DRAG_TYPE)) return null;
  if (entry.panelKey !== scopedThreadKey(panelRef)) return null;
  const { link } = entry;
  clear();
  return link;
}
