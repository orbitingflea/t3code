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
import { readPrimaryEnvironmentId } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";

import { canShowBoardRefInPanel, showBoardRef } from "../whiteboard/boardChannel";
import { type ChatFileOpener, fromChatOrigin } from "./chatFileOpener";
import { anchorPanelLink, PLAIN_CLICK } from "./linkSources";
import type { PanelLink } from "./panelLinkDrag";

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
  readonly opener: ChatFileOpener | null;
  readonly canOperatePreview: boolean;
  readonly issueTrackers: IssueTrackerConnectionList | undefined;
  readonly openChangeRequestLink: ReturnType<typeof useOpenChangeRequestLink>;
  readonly openIssueLink: ReturnType<typeof useOpenIssueLink>;
  readonly openExternalLinkInPreview: (url: string) => Promise<AtomCommandResult<void, unknown>>;
}): (href: string | undefined, autolink: string) => PanelLink | null {
  return (href, autolink) => {
    const { threadRef, issueTrackers, opener } = input;
    if (!href || threadRef === undefined) return null;
    const { environmentId } = threadRef;
    return anchorPanelLink({
      href,
      panelRef: opener?.().panel(),
      autolink,
      boardInPanel: () => canShowBoardRefInPanel(threadRef),
      showBoard: () => (opener ? opener().openBoardRef(href) : showBoardRef(href, threadRef)),
      changeRequestInPanel: () =>
        pullRequestInPanel(href, environmentId) || issueInPanel(href, environmentId, issueTrackers),
      canOpenInPreview: input.canOperatePreview && isPreviewAvailableFor(environmentId),
      openChangeRequest: () =>
        fromChatOrigin(
          opener,
          () =>
            input.openChangeRequestLink(PLAIN_CLICK, href, undefined, environmentId) ||
            input.openIssueLink(PLAIN_CLICK, href, environmentId, issueTrackers),
        ),
      openInPreview: async () => {
        const result = await input.openExternalLinkInPreview(href);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          reportMarkdownActionFailure(
            { operation: "open-link-in-preview", target: href },
            result.cause,
          );
        }
      },
    });
  };
}
