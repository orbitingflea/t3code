import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  IssueTrackerConnectionList,
  ScopedThreadRef,
  ThreadIssueLink,
} from "@t3tools/contracts";
import type { DragEvent } from "react";

import { canOpenLinksInApp } from "~/browser/browserLinkTarget";
import { isWebUrl } from "~/browser/webUrl";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { isPreviewAvailableFor } from "~/browser/previewRuntime";
import { recordVisitForThread } from "~/browserHistoryStore";
import { reportMarkdownActionFailure } from "~/components/chat/markdownActionFailure";
import { getClientSettings } from "~/hooks/useSettings";
import { issueLinkTarget, type useOpenIssueLink } from "~/lib/openIssueLink";
import { pullRequestLinkPanelTarget, useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProjects } from "~/state/entities";
import { readPrimaryEnvironmentId } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { canShowBoardRefInPanel, showBoardRef } from "../whiteboard/boardChannel";
import { type ChatFileOpener, fromChatOrigin } from "./chatFileOpener";
import { anchorPanelLink, PLAIN_CLICK } from "./linkSources";
import { type PanelLink, startPanelLinkDrag } from "./panelLinkDrag";

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

/** Opens `href` in the preview browser with `open` and reports a failure like a chat link. */
async function openLinkInPreview(
  href: string,
  open: () => Promise<AtomCommandResult<void, unknown>>,
): Promise<void> {
  const result = await open();
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    reportMarkdownActionFailure({ operation: "open-link-in-preview", target: href }, result.cause);
  }
}

type WebPanelLink = (href: string | undefined) => PanelLink | null;

/**
 * Returns a function that turns a web URL outside chat into a `PanelLink` for `threadRef`'s
 * preview browser, or `null` when unavailable.
 */
export function useWebPanelLink(threadRef: ScopedThreadRef | null): WebPanelLink {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return (raw) => {
    // Outside chat a click opens any web URL; commit and media links have their own opens in
    // chat only.
    if (threadRef === null || !raw || !isWebUrl(raw) || !canOpenLinksInApp(threadRef)) return null;
    // The URL the link's click resolves to; a raw destination such as `https:/host` is not one.
    const href = new URL(raw).href;
    return {
      panelRef: rightPanelHostRef(threadRef),
      open: () =>
        openLinkInPreview(href, async () => {
          const result = await openUrlInPreview({ threadRef, url: href, openPreview });
          // As a chat link's open: the visit joins the project's browser history.
          if (result._tag === "Success") recordVisitForThread(threadRef, href);
          return result;
        }),
    };
  };
}

/**
 * Returns the `PanelLink` for a pull request row in the Pull Requests panel or Thread details. A
 * drop opens the pull request tab that a click opens, or falls back to `webPanelLink`.
 */
function pullRequestRowPanelLink(
  url: string,
  threadRef: ScopedThreadRef,
  openChangeRequestLink: ReturnType<typeof useOpenChangeRequestLink>,
  webPanelLink: WebPanelLink,
): PanelLink | null {
  if (!pullRequestInPanel(url, threadRef.environmentId)) return webPanelLink(url);
  return {
    panelRef: rightPanelHostRef(threadRef),
    open: () => void openChangeRequestLink(PLAIN_CLICK, url, threadRef),
  };
}

/**
 * Returns a function that builds a row's `PanelLink` from its URL, for pull request rows whose
 * click opens the pull request link of `threadRef`.
 */
export function usePullRequestRowPanelLink(threadRef: ScopedThreadRef) {
  const openChangeRequestLink = useOpenChangeRequestLink(threadRef);
  const webPanelLink = useWebPanelLink(threadRef);
  return (url: string) =>
    pullRequestRowPanelLink(url, threadRef, openChangeRequestLink, webPanelLink);
}

/**
 * Returns the `PanelLink` for an issue row in Linked items or Thread details. A drop opens the
 * issue tab when the environment supports issues, or falls back to `webPanelLink`.
 */
function issueRowPanelLink(
  link: ThreadIssueLink,
  threadRef: ScopedThreadRef,
  webPanelLink: WebPanelLink,
): PanelLink | null {
  const serverConfigs = appAtomRegistry.get(environmentPresentations.serverConfigsAtom);
  if (serverConfigs.get(threadRef.environmentId)?.environment.capabilities.issues !== true) {
    return webPanelLink(link.url);
  }
  return {
    panelRef: rightPanelHostRef(threadRef),
    open: () => useRightPanelStore.getState().openIssue(threadRef, link),
  };
}

/**
 * Returns the `dragstart` handler for an issue row in Linked items or Thread details to drag its
 * `PanelLink` to a pane. Returns `undefined` for the sidebar tooltip row, whose click also opens
 * its thread.
 */
export function useIssueRowDrag(
  threadRef: ScopedThreadRef,
  link: ThreadIssueLink,
  mountScope: "thread-details" | "linked-items" | "sidebar-tooltip",
): ((event: DragEvent<HTMLElement>) => void) | undefined {
  const webPanelLink = useWebPanelLink(threadRef);
  // The sidebar tooltip's row click also opens its thread, so that row stays click only.
  if (mountScope === "sidebar-tooltip") return undefined;
  return (event) => startPanelLinkDrag(event, issueRowPanelLink(link, threadRef, webPanelLink));
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
      threadRef,
      opener,
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
      openInPreview: () => openLinkInPreview(href, () => input.openExternalLinkInPreview(href)),
    });
  };
}
