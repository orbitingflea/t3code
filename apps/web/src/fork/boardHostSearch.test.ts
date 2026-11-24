import { describe, expect, it } from "vite-plus/test";

import {
  filterAvailableSettingsSearchItems,
  searchSettings,
} from "../components/settings/settingsSearch";

describe("board host settings search", () => {
  it("finds the board host's settings only on a board host", () => {
    const availability = {
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    const ids = (query: string, isBoardHost?: boolean) =>
      searchSettings(
        query,
        filterAvailableSettingsSearchItems({
          ...availability,
          ...(isBoardHost === undefined ? {} : { isBoardHost }),
        }),
      ).map((item) => item.id);
    expect(ids("sidebar issues")).not.toContain("sidebar-pull-requests-issues");
    expect(ids("linked items")).not.toContain("right-panel-menu");
    expect(ids("sidebar issues", false)).not.toContain("sidebar-pull-requests-issues");
    expect(ids("sidebar issues", true)).toContain("sidebar-pull-requests-issues");
    expect(ids("linked items", false)).not.toContain("right-panel-menu");
    expect(ids("linked items", true)).toContain("right-panel-menu");
  });
});
