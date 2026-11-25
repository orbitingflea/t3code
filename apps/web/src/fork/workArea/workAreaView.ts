import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { RightPanelSurface, ThreadRightPanelState } from "~/rightPanelStore";

import { captureTabMove } from "./tabMoveScope";
import { focusedTab, resolveLayout, type WorkAreaLayout } from "./workArea.logic";
import { isStripView, NO_VIEW, shownSurfaces, type WorkAreaView } from "./workAreaGeometry.logic";
import type { OpenFrom, Placement } from "./workAreaPlacement.logic";

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
type RecordOrigin = {
  readonly record: ScopedThreadRef;
  readonly key: string;
  readonly from: OpenFrom;
  readonly guest?: string;
} | null;
let openOrigin: RecordOrigin = null;

/** The tab the current open started in, for a write to the record that open writes. */
export const currentOpenOrigin = (threadKey: string): OpenFrom | null =>
  openOrigin?.key === threadKey ? openOrigin.from : null;

/** Returns the live drop `Placement` for the current open in `record`, or `null` if none applies. */
export const currentDropAt = (record: ScopedThreadRef): Placement | null => {
  const drop = currentOpenOrigin(scopedThreadKey(record))?.drop;
  return drop?.live() ? drop.at : null;
};

// A side chat pane has no panel of its own, so its panel actions open in its parent's panel.
// Each live view of a guest holds one entry; the latest one routes, unless an open names its own.
const panelHosts = new Map<string, { readonly host: ScopedThreadRef }[]>();

export const panelHostOf = (guestKey: string): ScopedThreadRef | undefined =>
  (openOrigin?.guest === guestKey ? openOrigin.record : undefined) ??
  panelHosts.get(guestKey)?.at(-1)?.host;

export function addPanelHost(guest: ScopedThreadRef, host: ScopedThreadRef): () => void {
  const guestKey = scopedThreadKey(guest);
  const entry = { host };
  panelHosts.set(guestKey, [...(panelHosts.get(guestKey) ?? []), entry]);
  return () => {
    const rest = (panelHosts.get(guestKey) ?? []).filter((other) => other !== entry);
    if (rest.length > 0) panelHosts.set(guestKey, rest);
    else panelHosts.delete(guestKey);
  };
}

function runIn<T>(origin: RecordOrigin, run: () => T): T {
  const outer = openOrigin;
  openOrigin = origin;
  try {
    return run();
  } finally {
    openOrigin = outer;
  }
}

export function runWithOpenOrigin<T>(
  origin: { readonly record: ScopedThreadRef; readonly guest?: ScopedThreadRef } & OpenFrom,
  run: () => T,
): T {
  const { record, guest, ...own } = origin;
  const key = scopedThreadKey(record);
  // An open inside a drop to the same record keeps the drop's place over its own.
  const drop = own.drop ?? (openOrigin?.key === key ? openOrigin.from.drop : undefined);
  return runIn(
    {
      record,
      key,
      from: drop === undefined ? own : { ...own, drop },
      ...(guest === undefined ? {} : { guest: scopedThreadKey(guest) }),
    },
    run,
  );
}

/**
 * Returns a runner for a later step of the same open, such as after an await, under the origin
 * current at capture time. If none was current, the step keeps whatever origin its caller sets,
 * such as a drop around a chat opener created earlier.
 */
export function captureOpenOrigin(): <T>(run: () => T) => T {
  const captured = openOrigin;
  const move = captureTabMove();
  return (run) => move(() => (captured === null ? run() : runIn(captured, run)));
}

export function publishWorkAreaView(next: WorkAreaView): () => void {
  setView(next);
  return () => {
    if (view === next) setView(NO_VIEW);
  };
}

export const onWorkAreaViewChange = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** `check` of the published view; rerenders only when its answer flips. */
export function useWorkAreaViewCheck(check: (view: WorkAreaView) => boolean): boolean {
  return useSyncExternalStore(
    onWorkAreaViewChange,
    () => check(view),
    () => false,
  );
}

/** Whether `layout` draws as one strip now; rerenders only when that flips. */
export const useStripView = (layout: WorkAreaLayout): boolean =>
  useWorkAreaViewCheck((current) => isStripView(layout, current));

/** The focused pane's drawn surface of `kind` when it shows one, else the first drawn one. */
export function shownSurfaceOf(
  record: ThreadRightPanelState,
  kind: RightPanelSurface["kind"],
): RightPanelSurface | undefined {
  const shown = shownSurfaces(record, view).filter((surface) => surface.kind === kind);
  const focused = focusedTab(resolveLayout(record));
  return shown.find((surface) => surface.id === focused) ?? shown[0];
}

/** A view that only says how the layout draws, for readers that need no fit data. */
export const drawModeView = (strip: boolean): WorkAreaView => ({ narrow: strip, size: null });

/** Window event after the work area moves its panes; desktop browser slots re-place on it. */
export const WORK_AREA_LAYOUT_EVENT = "t3-work-area-layout";
