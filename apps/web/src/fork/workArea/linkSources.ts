import type { LinkedThreadTarget } from "@t3tools/client-runtime/linked-thread";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";

import { canOpenThreadInPanel } from "~/lib/sideChatPane";
import { type OpenFileOptions, rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";

import type { ChatFileOpener } from "./chatFileOpener";
import { openThreadTab } from "./chatOpenerContext";
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
 * A chat `<a>`. A drop runs the click's in-app open; a branch that would leave the app is
 * dropped, since choosing a pane is choosing the app. Reference autolinks, commit links and
 * media links have no panel open of their own, so they do not drag to the panel.
 */
export function anchorPanelLink(input: {
  readonly href: string;
  /** The layout the click opens in. */
  readonly panelRef: ScopedThreadRef | undefined;
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
  const { href, panelRef } = input;
  if (panelRef === undefined) return null;
  if (href.startsWith("board://")) {
    return input.boardInPanel() ? { panelRef, open: input.showBoard } : null;
  }
  if (input.autolink !== "" || !/^https?:\/\//i.test(href)) return null;
  const media = mediaKindFromPath(href);
  if ((media !== null && media !== "audio") || sourceControlClients.parseCommitUrl(href) !== null) {
    return null;
  }
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

/** A thread chip: a same-environment thread opens as a tab; a linked one reads in the panel. */
export function threadChipPanelLink(input: {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly target:
    | { readonly kind: "local"; readonly ref: ScopedThreadRef }
    | { readonly kind: "linked"; readonly target: LinkedThreadTarget };
  readonly opener: ChatFileOpener | null;
}): PanelLink | null {
  const { threadRef, target, opener } = input;
  if (threadRef === undefined) return null;
  if (target.kind === "local" && !canOpenThreadInPanel(target.ref, threadRef)) return null;
  return {
    panelRef: rightPanelHostRef(threadRef),
    opensChat: target.kind === "local",
    open: () => {
      if (target.kind === "local" && openThreadTab(opener, target.ref)) return;
      const store = useRightPanelStore.getState();
      if (target.kind === "local") store.openThread(threadRef, target.ref.threadId);
      else store.openLinkedThread(threadRef, target.target);
    },
  };
}
