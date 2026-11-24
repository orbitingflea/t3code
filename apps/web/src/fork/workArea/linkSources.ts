import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { LinkedThreadTarget } from "@t3tools/client-runtime/linked-thread";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";

import { type OpenFileOptions, rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";
import { readThreadShell } from "~/state/entities";

import { type ChatFileOpener, fromChatOrigin } from "./chatFileOpener";
import { openThreadTab, threadTabPanel } from "./chatOpenerContext";
import type { PanelLink, PanelLinkOwner } from "./panelLinkDrag";

/** The `event` a click opener takes, for a drop: a plain primary click with nothing held. */
export const PLAIN_CLICK = {
  preventDefault() {},
  stopPropagation() {},
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  button: 0,
};

// A Files tree in `owner`'s work area: a dropped row keeps the Files tab open beside it.
export const filesTreeOwner = (owner: ScopedThreadRef): PanelLinkOwner => ({
  ref: owner,
  openFile: (path) =>
    useRightPanelStore.getState().openFile(owner, path, undefined, { keepExplorer: true }),
});

// A linked file's Files tree reads `source`'s workspace, so a row opens as `source`'s linked file.
export const linkedTreeOwner = (
  owner: ScopedThreadRef,
  source: ScopedThreadRef,
): PanelLinkOwner => ({
  ref: owner,
  openFile: (path) =>
    useRightPanelStore
      .getState()
      .updateWorkArea(owner, { type: "link-file", source, path, line: null }),
});

/** A file row in a panel's Files tree. `owner` opens it as a panel file or a linked file. */
export function fileRowPanelLink(input: {
  readonly owner: PanelLinkOwner | null;
  readonly treePath: string | null;
  readonly isFile: (treePath: string) => boolean;
  readonly panelPath: (treePath: string) => string;
}): PanelLink | null {
  const { owner } = input;
  const treePath = input.treePath?.replace(/\/+$/, "");
  if (owner === null || !treePath || !input.isFile(treePath)) return null;
  const path = input.panelPath(treePath);
  return { panelRef: owner.ref, open: () => owner.openFile(path) };
}

/**
 * A chat file chip, owned by the layout its click opens in. A dropped file keeps a standalone Files
 * tab open beside it.
 */
export function fileChipPanelLink(
  opener: ChatFileOpener | null,
  panelPath: string | null | undefined,
  openInPanel: (panelPath: string, options: OpenFileOptions) => void | Promise<unknown>,
): PanelLink | null {
  if (opener === null || !panelPath) return null;
  return {
    panelRef: opener().panel(),
    open: () => openInPanel(panelPath, { keepExplorer: true }),
  };
}

/**
 * Returns the `PanelLink` for a "+" menu or launcher item in `owner`'s work area, or `null` when
 * unavailable or `opensTab` is false. A drop runs `action.onClick` at the drop's place.
 */
export function surfaceActionPanelLink(
  owner: PanelLinkOwner | null,
  action: {
    readonly id: string;
    readonly available: boolean;
    readonly onClick: () => void | Promise<unknown>;
  },
  opensTab = true,
): PanelLink | null {
  if (owner === null || !action.available || !opensTab) return null;
  return {
    panelRef: owner.ref,
    open: action.onClick,
    composer: action.id === "side-chat" || action.id === "chat",
  };
}

/**
 * Returns the `PanelLink` for a Reply button or Replies list row, or `null` without `opener`. A
 * drop opens the sub-thread tab for `first`.
 */
export function replyPanelLink(opener: ChatFileOpener | null, first: string): PanelLink | null {
  if (opener === null) return null;
  return { panelRef: opener().panel(), composer: true, open: () => opener().openSubThread(first) };
}

/** Returns true for an HTTP or HTTPS link that is not an autolink, commit URL, image, or video. */
function isWebPageLink(href: string, autolink = ""): boolean {
  if (autolink !== "" || !/^https?:\/\//i.test(href)) return false;
  const media = mediaKindFromPath(href);
  return (
    (media === null || media === "audio") && sourceControlClients.parseCommitUrl(href) === null
  );
}

/**
 * A chat `<a>`. A drop runs the click's in-app open; a branch that would leave the app is
 * dropped, since choosing a pane is choosing the app. Reference autolinks, commit links and
 * media links have no panel open of their own, so they do not drag to the panel.
 */
export function anchorPanelLink(input: {
  readonly href: string;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly opener: ChatFileOpener | null;
  /** The anchor's `data-pull-request-autolink`: "", "reference", "mention" or "commit". */
  readonly autolink: string;
  /** Whether a click on this `board://` link would show the board in this panel. */
  readonly boardInPanel: () => boolean;
  readonly showBoard: () => void;
  /** Whether a click would open this pull request or issue link in this panel. */
  readonly changeRequestInPanel: () => boolean;
  readonly canOpenInPreview: boolean;
  /** The pull request opener, else the issue opener, with `PLAIN_CLICK`. */
  readonly openChangeRequest: () => boolean;
  readonly openInPreview: () => Promise<unknown>;
}): PanelLink | null {
  const { href, threadRef } = input;
  if (threadRef === undefined) return null;
  // The record the click's store write lands in, which a guest's origin routes to its owner.
  const panelRef = fromChatOrigin(input.opener, () => rightPanelHostRef(threadRef));
  if (href.startsWith("board://")) {
    return input.boardInPanel() ? { panelRef, open: input.showBoard } : null;
  }
  if (!isWebPageLink(href, input.autolink)) return null;
  const changeRequest = input.changeRequestInPanel();
  if (!changeRequest && !input.canOpenInPreview) return null;
  return {
    panelRef,
    open: () => {
      if (changeRequest && input.openChangeRequest()) return;
      if (input.canOpenInPreview) return input.openInPreview();
    },
  };
}

/**
 * Returns the `PanelLink` for a thread chip whose click opens a tab, or `null` otherwise. It opens
 * a same-project thread as a Chat tab, a side chat of the panel's own thread as its tab, or a
 * linked thread to read in the panel.
 */
export function threadChipPanelLink(input: {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly target:
    | { readonly kind: "local"; readonly ref: ScopedThreadRef }
    | { readonly kind: "linked"; readonly target: LinkedThreadTarget };
  readonly opener: ChatFileOpener | null;
}): PanelLink | null {
  const { threadRef, target, opener } = input;
  if (threadRef === undefined) return null;
  if (target.kind === "linked") {
    return {
      panelRef: rightPanelHostRef(threadRef),
      open: () => useRightPanelStore.getState().openLinkedThread(threadRef, target.target),
    };
  }
  const chatPanel = threadTabPanel(opener, target.ref);
  if (chatPanel !== null) {
    return {
      panelRef: chatPanel,
      composer: true,
      open: () => void openThreadTab(opener, target.ref),
    };
  }
  // The click's side chat route (`resolveThreadOpenRoute`), which stays on this page only for a
  // side chat of the panel's own thread.
  const lineage = readThreadShell(target.ref)?.lineage;
  const parentId = lineage?.sideChat === true ? lineage.parentThreadId : null;
  if (opener === null || parentId === null) return null;
  const parent = scopeThreadRef(target.ref.environmentId, parentId);
  const panelRef = opener().panel();
  if (scopedThreadKey(parent) !== scopedThreadKey(panelRef)) return null;
  return {
    panelRef,
    composer: true,
    open: () => useRightPanelStore.getState().openThread(parent, target.ref.threadId),
  };
}
