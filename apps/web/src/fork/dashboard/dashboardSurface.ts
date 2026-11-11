import type { ScopedThreadRef } from "@t3tools/contracts";
import { resolveDisplayMode } from "@t3tools/shared/displayModes";
import { LayoutDashboard, MessageSquareReply } from "lucide-react";
import { createElement } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { useThreadDisplayMode } from "../displayMode/useThreadDisplayMode";

/** The right-panel tabs that a display mode can have. A mode has at most one of them. */
const MODE_SURFACES = {
  dashboard: { label: "Dashboard", icon: LayoutDashboard },
  replies: { label: "Replies", icon: MessageSquareReply },
} as const;
type ModeSurfaceKind = keyof typeof MODE_SURFACES;

/** Opens the mode's tab. The function carries which tab that is, so one prop serves every mode. */
type ModeSurfaceAdder = (() => void) & { readonly modeSurface?: ModeSurfaceKind };

/** The right panel's item for the mode's tab, listed only when `onAdd` is given. */
export const dashboardSurfaceActions = (onAdd: ModeSurfaceAdder | undefined) =>
  onAdd === undefined
    ? []
    : [
        {
          ...MODE_SURFACES[onAdd.modeSurface ?? "dashboard"],
          // No key: an empty shortcut matches no key press and renders no hint.
          shortcut: "",
          available: true,
          disabledReason: "",
          onClick: onAdd,
        },
      ];

export const ModeSurfaceIcon = (props: { readonly kind: ModeSurfaceKind }) =>
  createElement(MODE_SURFACES[props.kind].icon, { className: "size-3 shrink-0" });

const modeSurfaceOf = (mode: {
  readonly dashboard: boolean;
  readonly subThreads: boolean;
}): ModeSurfaceKind | null => (mode.dashboard ? "dashboard" : mode.subThreads ? "replies" : null);

/** Whether the thread's display mode has the tab `kind`, read outside React. Other tabs need no mode. */
export function threadHasModeSurface(threadRef: ScopedThreadRef, kind: string): boolean {
  if (!(kind in MODE_SURFACES)) return true;
  const settings = appAtomRegistry.get(
    serverEnvironment.settingsValueAtom(threadRef.environmentId),
  );
  return (
    modeSurfaceOf(resolveDisplayMode(settings?.threadDisplayModes[threadRef.threadId])) === kind
  );
}

/** Opens the tab of the thread's display mode: Dashboard or Replies. Undefined when the mode has none. */
export function useDashboardSurfaceAdder(
  threadRef: ScopedThreadRef | null,
): ModeSurfaceAdder | undefined {
  const kind = modeSurfaceOf(useThreadDisplayMode(threadRef));
  const add = useStableCallback(() => {
    if (threadRef !== null && kind !== null) useRightPanelStore.getState().open(threadRef, kind);
  });
  return kind === null ? undefined : Object.assign(() => add(), { modeSurface: kind });
}
