import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IssueTrackerConnectionList,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { isPreviewAvailableFor } from "~/browser/previewRuntime";
import { reportMarkdownActionFailure } from "~/components/chat/markdownActionFailure";
import { getClientSettings } from "~/hooks/useSettings";
import { issueLinkTarget, type useOpenIssueLink } from "~/lib/openIssueLink";
import {
  pullRequestLinkPanelTarget,
  type useOpenChangeRequestLink,
} from "~/lib/openPullRequestLink";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProjects } from "~/state/entities";
import {
  rightPanelHostRef,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { readPrimaryEnvironmentId } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";

import { canShowBoardRefInPanel, showBoardRef } from "../whiteboard/boardChannel";
import { anchorPanelLink, PLAIN_CLICK } from "./linkSources";
import type { OpenedSurface, PanelLink } from "./panelLinkDrag";

/** The pull request opener's own panel check (`useOpenChangeRequestLink`), read at dragstart. */
function pullRequestInPanel(url: string, environmentId: EnvironmentId): boolean {
  return (
    getClientSettings().pullRequestLinksOpenInApp &&
    pullRequestLinkPanelTarget({
      url,
      environmentId,
      primaryEnvironmentId: readPrimaryEnvironmentId(),
      lendHostProject: true,
    }) !== null
  );
}

/** The issue opener's own check (`useOpenIssueLink`), read at dragstart. */
function issueInPanel(
  url: string,
  environmentId: EnvironmentId,
  trackers: IssueTrackerConnectionList | undefined,
): boolean {
  const serverConfigs = appAtomRegistry.get(environmentPresentations.serverConfigsAtom);
  return (
    issueLinkTarget({ url, environmentId, serverConfigs, projects: readProjects(), trackers }) !==
    null
  );
}

/** A chat renderer's anchors, as panel links built at dragstart with the click's own openers. */
export function chatAnchorPanelLinks(input: {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly canOperatePreview: boolean;
  readonly issueTrackers: IssueTrackerConnectionList | undefined;
  readonly openChangeRequestLink: ReturnType<typeof useOpenChangeRequestLink>;
  readonly openIssueLink: ReturnType<typeof useOpenIssueLink>;
  /** The chat's own preview open; `onOpened` runs right after it opens the tab. */
  readonly openExternalLinkInPreview: (
    url: string,
    onOpened: () => void,
  ) => Promise<AtomCommandResult<void, unknown>>;
}): (href: string | undefined, autolink: string) => PanelLink | null {
  return (href, autolink) => {
    const { threadRef, issueTrackers } = input;
    if (!href || threadRef === undefined) return null;
    const { environmentId } = threadRef;
    return anchorPanelLink({
      href,
      threadRef,
      autolink,
      boardInPanel: () => canShowBoardRefInPanel(threadRef),
      showBoard: () => showBoardRef(href, threadRef),
      changeRequestInPanel: () =>
        pullRequestInPanel(href, environmentId) || issueInPanel(href, environmentId, issueTrackers),
      canOpenInPreview: input.canOperatePreview && isPreviewAvailableFor(environmentId),
      openChangeRequest: () =>
        input.openChangeRequestLink(PLAIN_CLICK, href, undefined, environmentId) ||
        input.openIssueLink(PLAIN_CLICK, href, environmentId, issueTrackers),
      openInPreview: async () => {
        const panelRef = rightPanelHostRef(threadRef);
        let opened: OpenedSurface = null;
        const result = await input.openExternalLinkInPreview(href, () => {
          opened = selectThreadRightPanelState(
            useRightPanelStore.getState().byThreadKey,
            panelRef,
          ).activeSurfaceId;
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          reportMarkdownActionFailure(
            { operation: "open-link-in-preview", target: href },
            result.cause,
          );
        }
        return result._tag === "Success" ? opened : null;
      },
    });
  };
}
