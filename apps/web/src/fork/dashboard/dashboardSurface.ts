import type { ScopedThreadRef } from "@t3tools/contracts";
import { resolveDisplayMode } from "@t3tools/shared/displayModes";
import { LayoutDashboard } from "lucide-react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { useThreadDisplayMode } from "../displayMode/useThreadDisplayMode";

/** The right panel's "Dashboard" item, listed only when `onAdd` is given. */
export const dashboardSurfaceActions = (onAdd: (() => void) | undefined) =>
  onAdd === undefined
    ? []
    : [
        {
          label: "Dashboard",
          icon: LayoutDashboard,
          // No key: an empty shortcut matches no key press and renders no hint.
          shortcut: "",
          available: true,
          disabledReason: "",
          onClick: onAdd,
        },
      ];

/** Whether the thread's display mode has a Dashboard, read outside React. */
export function threadHasDashboard(threadRef: ScopedThreadRef): boolean {
  const settings = appAtomRegistry.get(
    serverEnvironment.settingsValueAtom(threadRef.environmentId),
  );
  return resolveDisplayMode(settings?.threadDisplayModes[threadRef.threadId]).dashboard;
}

/** Opens the thread's Dashboard tab. Undefined unless the thread's display mode has a Dashboard. */
export function useDashboardSurfaceAdder(
  threadRef: ScopedThreadRef | null,
): (() => void) | undefined {
  const { dashboard } = useThreadDisplayMode(threadRef);
  const add = useStableCallback(() => {
    if (threadRef !== null) useRightPanelStore.getState().open(threadRef, "dashboard");
  });
  return dashboard ? add : undefined;
}
