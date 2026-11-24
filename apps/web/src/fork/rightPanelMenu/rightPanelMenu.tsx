import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Link } from "@tanstack/react-router";

import { Button } from "../../components/ui/button";
import { MenuItem } from "../../components/ui/menu";
import type { SettingsPath } from "../../components/settings/settingsSearch";
import { useClientSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { deviceEnvironment } from "../../state/device";
import { isBoardHost, useBoardHostRole, useIsBoardHost } from "../whiteboard/role";
import { surfaceActionPanelLink } from "../workArea/linkSources";
import { panelDragProps, usePanelLinkOwner } from "../workArea/panelLinkDrag";
import {
  type ArrangedAction,
  arrangeSurfaceActions,
  deviceOpensSetup,
  type MenuAction,
  parseMenuLayer,
} from "./menu.logic";

const RIGHT_PANEL_SETTINGS_PATH = "/settings/right-panel" satisfies SettingsPath;

/**
 * The "+" menu or launcher items after built-in defaults, the machine's choices, and this
 * browser's choices. Off a board host, this hook returns upstream's list unchanged.
 */
export function useArrangedSurfaceActions<A extends MenuAction>(
  actions: ReadonlyArray<A>,
): ReadonlyArray<ArrangedAction<A>> {
  const role = useBoardHostRole();
  const browser = useClientSettings((settings) => settings.rightPanelMenuOverrides);
  // Off a board host, return the upstream list unchanged. While the role is unknown, apply
  // the built-in defaults and browser choices with no machine layer.
  if (role === "off") return actions as ReadonlyArray<ArrangedAction<A>>;
  const machine = isBoardHost(role) ? parseMenuLayer(role.menu) : {};
  return arrangeSurfaceActions(actions, machine, parseMenuLayer(browser));
}

/**
 * Returns a helper that builds drag props for a "+" menu or launcher item. The helper returns an
 * empty object outside a work area or when the item is unavailable. It checks Device at drag start
 * and again at the drop. If Device needs setup, the drag does not start and the drop opens
 * nothing. `onDragEnd` runs when the drag ends.
 */
export function useSurfaceActionDrag(environmentId: EnvironmentId | null) {
  const owner = usePanelLinkOwner();
  return (
    action: Parameters<typeof surfaceActionPanelLink>[1],
    onDragEnd?: () => void,
  ): Partial<ReturnType<typeof panelDragProps>> => {
    if (surfaceActionPanelLink(owner, action) === null) return {};
    const opensTab = () =>
      action.id !== "device" || !deviceOpensSetup(readDeviceState(environmentId));
    // Run by the drag itself: a drop can unmount the item, as placing the Chat removes its item.
    // Device is checked then too, against the state its click reads, so no pane subscribes to it,
    // and again at the drop, since setup can become needed while the drag runs.
    return panelDragProps(
      () =>
        surfaceActionPanelLink(
          owner,
          { ...action, onClick: () => (opensTab() ? action.onClick() : undefined) },
          opensTab(),
        ),
      onDragEnd,
    );
  };
}

// The Device state the click's `useDeviceState` holds, or null before it loads.
function readDeviceState(environmentId: EnvironmentId | null) {
  if (environmentId === null) return null;
  const query = appAtomRegistry.get(deviceEnvironment.state({ environmentId, input: {} }));
  return AsyncResult.getOrElse(query, () => null);
}

export type SurfaceActionDrag = ReturnType<typeof useSurfaceActionDrag>;

/** The settings nav with Right panel after Keybindings, on a board host only. */
export function useForkSettingsNavGroups<
  Group extends { readonly paths: ReadonlyArray<SettingsPath> },
>(groups: ReadonlyArray<Group>): ReadonlyArray<Group> {
  const offered = useIsBoardHost();
  if (!offered) return groups;
  return groups.map((group) => ({
    ...group,
    paths: group.paths.flatMap((path) =>
      path === "/settings/keybindings" ? [path, RIGHT_PANEL_SETTINGS_PATH] : [path],
    ),
  }));
}

const ALL_HIDDEN = "All items are hidden.";
const OPEN_SETTINGS = "Settings > Right panel";

/** Shown in place of a launcher or "+" menu whose items are all hidden. */
export function AllMenuItemsHidden(props: { readonly in: "launcher" | "menu" }) {
  if (props.in === "menu") {
    return (
      <MenuItem render={<Link to={RIGHT_PANEL_SETTINGS_PATH} />}>
        {ALL_HIDDEN} {OPEN_SETTINGS}
      </MenuItem>
    );
  }
  return (
    <p className="text-center text-muted-foreground text-sm">
      {ALL_HIDDEN}{" "}
      <Button size="xs" variant="link" render={<Link to={RIGHT_PANEL_SETTINGS_PATH} />}>
        {OPEN_SETTINGS}
      </Button>
    </p>
  );
}
