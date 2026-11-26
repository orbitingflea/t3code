import "~/index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { RightPanelTabs, type RightPanelTabsProps } from "~/components/RightPanelTabs";
import type { RightPanelSurface } from "~/rightPanelStore";
import { render } from "../../../test/render";

// A board host whose Settings > Right panel hides every item of the "+" menu.
vi.mock("./rightPanelMenu", async (importActual) => ({
  ...(await importActual<typeof import("./rightPanelMenu")>()),
  useArrangedSurfaceActions: () => [],
}));

const DIFF_SURFACE: RightPanelSurface = { id: "diff", kind: "diff" };

function tabs() {
  const noop = () => {};
  const props: RightPanelTabsProps = {
    mode: "inline",
    keybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: true,
      isWeb: true,
      isDesktop: false,
    }),
    surfaces: [DIFF_SURFACE],
    environmentId: EnvironmentId.make("environment-local"),
    activeSurfaceId: DIFF_SURFACE.id,
    pendingSurfaceIds: new Set(),
    previewSessions: {},
    desktopByTabId: {},
    terminalLabelsById: new Map(),
    onActivate: noop,
    onCloseSurface: noop,
    onCloseOtherSurfaces: noop,
    onCloseSurfacesToRight: noop,
    onCloseAllSurfaces: noop,
    onCopyFilePath: noop,
    onAddBrowser: noop,
    onAddBrowserInProfile: noop,
    onAddTerminal: noop,
    onAddDiff: noop,
    onAddFiles: noop,
    onAddPullRequest: noop,
    onAddPullRequests: noop,
    onAddDevice: noop,
    browserAvailable: true,
    terminalAvailable: true,
    diffAvailable: true,
    filesAvailable: true,
    pullRequestAvailable: true,
    pullRequestsAvailable: true,
    deviceAvailable: true,
    open: true,
    children: null,
  };
  return <RightPanelTabs {...props} />;
}

describe("add surface menu with every item hidden", () => {
  it("keeps the + button, whose menu points to the settings that hid the items", async () => {
    await using screen = await render(tabs());
    const addButton = screen.getByRole("button", { name: "Add panel surface" });

    await expect.element(addButton).toBeInTheDocument();
    await userEvent.click(addButton);
    await expect
      .element(page.getByRole("menuitem", { name: /All items are hidden/ }))
      .toBeVisible();
  });
});
