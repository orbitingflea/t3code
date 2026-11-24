import type { SettingsSearchItem } from "../components/settings/settingsSearch";
import { FORK_SETTING_TITLES, SIDEBAR_LINKS_COPY } from "./forkCopy";

export const BOARD_HOST_SEARCH_ITEMS = [
  {
    id: "right-panel-menu",
    title: FORK_SETTING_TITLES.rightPanel,
    to: "/settings/right-panel",
    boardHostOnly: true,
    searchTerms: [
      "plus menu launcher surface whiteboard board hide show letter shortcut key",
      "diff pull request requests pr prs linked items device",
    ],
  },
  {
    id: "sidebar-pull-requests-issues",
    title: SIDEBAR_LINKS_COPY.title,
    to: "/settings/general",
    boardHostOnly: true,
    searchTerms: [SIDEBAR_LINKS_COPY.searchTerms],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
