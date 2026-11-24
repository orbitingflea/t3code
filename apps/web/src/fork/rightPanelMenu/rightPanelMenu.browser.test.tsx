import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import type { RightPanelMenuItemId } from "./menu.logic";
import { useArrangedSurfaceActions } from "./rightPanelMenu";

const host = vi.hoisted(() => ({
  role: "off" as "off" | "unknown" | { readonly menu: Record<string, unknown> },
}));

vi.mock("../whiteboard/role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../whiteboard/role")>()),
  useBoardHostRole: () => host.role,
}));

const ACTIONS = (["browser", "diff", "pull-request", "pull-requests", "device"] as const).map(
  (id: RightPanelMenuItemId) => ({ id, shortcut: "", available: true }),
);

function Menu() {
  const actions = useArrangedSurfaceActions(ACTIONS);
  return <output>{`[${actions.map((action) => action.id).join(",")}]`}</output>;
}

describe("useArrangedSurfaceActions", () => {
  it.each<{ name: string; role: typeof host.role; shown: string }>([
    {
      name: "off a board host, lists every item",
      role: "off",
      shown: ACTIONS.map((a) => a.id).join(","),
    },
    {
      name: "while the role is unknown, hides the default-hidden items",
      role: "unknown",
      shown: "browser",
    },
    {
      name: "on a board host, hides the default-hidden items",
      role: { menu: {} },
      shown: "browser",
    },
    {
      name: "on a board host, shows an item the machine shows",
      role: { menu: { device: { hidden: false } } },
      shown: "browser,device",
    },
  ])("$name", async ({ role, shown }) => {
    host.role = role;
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    await using screen = await render(<Menu />);
    await expect.element(screen.getByRole("status")).toHaveTextContent(`[${shown}]`);
  });
});
