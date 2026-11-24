import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { useSearchableSetting } from "~/components/settings/settingsSearch";
import { Switch } from "~/components/ui/switch";
import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import { useIssuesSupported, usePullRequestsSupported } from "~/state/environments";

import { SIDEBAR_LINKS_COPY as COPY } from "../forkCopy";
import { isBoardHost, useBoardHostRole } from "../whiteboard/role";

/**
 * Returns whether each link is supported and shown. Supported links show when role is "off".
 * On a board host or while "unknown" until server config loads, they follow this browser's switch.
 */
export function useSidebarUtilityLinks(): {
  readonly pullRequests: boolean;
  readonly issues: boolean;
} {
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  const role = useBoardHostRole();
  const turnedOn = useClientSettings((settings) => settings.sidebarPullRequestsAndIssuesShown);
  const shown = role === "off" || turnedOn;
  return { pullRequests: pullRequestsSupported && shown, issues: issuesSupported && shown };
}

/** Settings > General > Sidebar switch for Pull requests and Issues. Renders only on a board host. */
export function SidebarPullRequestsAndIssuesSetting() {
  const setting = useSearchableSetting();
  const role = useBoardHostRole();
  const turnedOn = useClientSettings((settings) => settings.sidebarPullRequestsAndIssuesShown);
  if (!isBoardHost(role)) return null;
  return (
    <SettingsRow
      {...setting("sidebar-pull-requests-issues")}
      description={COPY.description}
      resetAction={
        turnedOn !== DEFAULT_CLIENT_SETTINGS.sidebarPullRequestsAndIssuesShown ? (
          <SettingResetButton
            ariaLabel={COPY.reset}
            onClick={() =>
              void updateClientSettings({
                sidebarPullRequestsAndIssuesShown:
                  DEFAULT_CLIENT_SETTINGS.sidebarPullRequestsAndIssuesShown,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={turnedOn}
          onCheckedChange={(checked) =>
            void updateClientSettings({ sidebarPullRequestsAndIssuesShown: Boolean(checked) })
          }
          aria-label={COPY.switchLabel}
        />
      }
    />
  );
}
