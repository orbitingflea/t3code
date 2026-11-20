import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { RightPanelSurface, ThreadRightPanelState } from "~/rightPanelStore";

import { resolveLayout, type TabId, type WorkAreaLayout } from "./workArea.logic";
import {
  chatColumnBox,
  type CssBox,
  isStripView,
  NO_VIEW,
  primaryChatRect,
  shownSurfaces,
  type WorkAreaView,
} from "./workAreaGeometry.logic";

// The mounted work area publishes the window facts store writes need for placement.
let view: WorkAreaView = NO_VIEW;
const listeners = new Set<() => void>();

export const currentWorkAreaView = (): WorkAreaView => view;

function setView(next: WorkAreaView) {
  if (view === next) return;
  view = next;
  for (const listener of listeners) listener();
}

// The tab an open started in and the record it writes, for that one synchronous call.
let openOrigin: { readonly record: string; readonly tab: TabId } | null = null;

/** The tab the current open started in, for a write to the record that open writes. */
export const currentOpenOrigin = (threadKey: string): TabId | null =>
  openOrigin?.record === threadKey ? openOrigin.tab : null;

export function runWithOpenOrigin<T>(
  origin: { readonly record: ScopedThreadRef; readonly tab: TabId },
  run: () => T,
): T {
  const outer = openOrigin;
  openOrigin = { record: scopedThreadKey(origin.record), tab: origin.tab };
  try {
    return run();
  } finally {
    openOrigin = outer;
  }
}

export function publishWorkAreaView(next: WorkAreaView): () => void {
  setView(next);
  return () => {
    if (view === next) setView(NO_VIEW);
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether `layout` draws as one strip now; rerenders only when that flips. */
export function useStripView(layout: WorkAreaLayout): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isStripView(layout, view),
    () => false,
  );
}

/** A view that only says how the layout draws, for readers that need no fit data. */
export const drawModeView = (strip: boolean): WorkAreaView => ({ narrow: strip, size: null });

/** Window event after the work area moves its panes; desktop browser slots re-place on it. */
export const WORK_AREA_LAYOUT_EVENT = "t3-work-area-layout";

const PANE_COLUMN_CLASS =
  "absolute z-[1] [&>[data-chat-header]]:[-webkit-app-region:no-drag]! [&>[data-chat-header]]:pl-(--workspace-gutter-start)!";

interface ChatColumnPlacement {
  readonly className: string;
  readonly style: CssBox | undefined;
  /** Hidden and inert, still mounted: no drawn pane shows the primary Chat. */
  readonly away: boolean;
}

const DOCKED: ChatColumnPlacement = { className: "flex-1", style: undefined, away: false };
const AWAY: ChatColumnPlacement = {
  className: "absolute top-0 left-0 h-full w-0",
  style: undefined,
  away: true,
};

/**
 * Where ChatView draws its chat column, and which surfaces a pane shows (the mini player hides
 * those). An embedded ChatView has no work area and keeps its docked column.
 */
export function useWorkAreaChat(
  record: ThreadRightPanelState,
  embedded: boolean,
): { readonly column: ChatColumnPlacement; readonly shown: readonly RightPanelSurface[] } {
  const layout = resolveLayout(record);
  const strip = useStripView(layout);
  if (embedded) return { column: DOCKED, shown: [] };
  const drawn = drawModeView(strip);
  const rect = primaryChatRect(layout, drawn);
  return {
    column: rect ? { className: PANE_COLUMN_CLASS, style: chatColumnBox(rect), away: false } : AWAY,
    shown: shownSurfaces(record, drawn),
  };
}
