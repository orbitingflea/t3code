import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { SidebarChromeFooter } from "../../components/sidebar/SidebarChrome";
import { SidebarProvider } from "../../components/ui/sidebar";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { useIssuesSupported, usePullRequestsSupported } from "../../state/environments";
import { SIDEBAR_LINKS_COPY } from "../forkCopy";
import { SidebarPullRequestsAndIssuesSetting } from "./sidebarLinks";

const host = vi.hoisted(() => ({ role: "off" as "off" | "unknown" | { readonly menu: object } }));

vi.mock("../whiteboard/role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../whiteboard/role")>()),
  useBoardHostRole: () => host.role,
}));
vi.mock("../../state/environments", { spy: true });

function setup(role: typeof host.role) {
  host.role = role;
  vi.mocked(usePullRequestsSupported).mockReturnValue(true);
  vi.mocked(useIssuesSupported).mockReturnValue(true);
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  return {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };
}

const renderSidebarAndSetting = () =>
  render(
    <SidebarProvider>
      <SidebarChromeFooter />
      <SidebarPullRequestsAndIssuesSetting />
    </SidebarProvider>,
  );

describe("sidebar Pull requests and Issues", () => {
  it("are hidden on a board host until this browser turns them on", async () => {
    using _settings = setup({ menu: {} });
    await using screen = await renderSidebarAndSetting();

    await expect.element(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Usage" })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Pull requests" }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Issues" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: SIDEBAR_LINKS_COPY.switchLabel }));

    await expect.element(screen.getByRole("button", { name: "Pull requests" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Issues" })).toBeVisible();
  });

  it.each([
    { saved: false, shown: false },
    { saved: true, shown: true },
  ])(
    "follow this browser's saved choice ($saved) while the board-host role is unknown",
    async ({ saved, shown }) => {
      using _settings = setup("unknown");
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        sidebarPullRequestsAndIssuesShown: saved,
      });
      await using screen = await render(
        <SidebarProvider>
          <SidebarChromeFooter />
        </SidebarProvider>,
      );

      await expect.element(screen.getByRole("button", { name: "Usage" })).toBeVisible();
      for (const name of ["Pull requests", "Issues"]) {
        const button = expect.element(screen.getByRole("button", { name }));
        await (shown ? button.toBeVisible() : button.not.toBeInTheDocument());
      }
    },
  );

  it("show off a board host, which has no setting for them", async () => {
    using _settings = setup("off");
    await using screen = await renderSidebarAndSetting();

    await expect.element(screen.getByRole("button", { name: "Pull requests" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Issues" })).toBeVisible();
    await expect
      .element(screen.getByRole("switch", { name: SIDEBAR_LINKS_COPY.switchLabel }))
      .not.toBeInTheDocument();
  });
});
