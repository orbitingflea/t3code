import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { LinkedThreadTarget } from "@t3tools/client-runtime/linked-thread";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";

import { canOpenThreadInPanel } from "~/lib/sideChatPane";
import { type OpenFileOptions, rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";

import type { OpenedSurface, PanelLink } from "./panelLinkDrag";

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

/** Runs a store open and gives the tab it activated by a user action on `panelRef`'s panel. */
export function openedSync(panelRef: ScopedThreadRef, open: () => unknown): OpenedSurface {
  const key = scopedThreadKey(panelRef);
  const read = () => {
    const state = useRightPanelStore.getState();
    return [state.byThreadKey[key], state.userActionRevisionByThreadKey[key]] as const;
  };
  const [record, revision] = read();
  open();
  const [nextRecord, nextRevision] = read();
  // Re-opening the active tab changes no record, but every user action bumps the revision.
  const opened = nextRecord !== record || nextRevision !== revision;
  return opened ? (nextRecord?.activeSurfaceId ?? null) : null;
}

/** A Files tree row, inside a ChatView panel (`owner`). Only a file row; the Files tab stays open. */
export function fileRowPanelLink(input: {
  readonly owner: ScopedThreadRef | null;
  readonly treePath: string | null;
  readonly isFile: (treePath: string) => boolean;
  readonly panelPath: (treePath: string) => string;
}): PanelLink | null {
  const { owner } = input;
  const treePath = input.treePath?.replace(/\/+$/, "");
  if (owner === null || !treePath || !input.isFile(treePath)) return null;
  const path = input.panelPath(treePath);
  return {
    panelRef: owner,
    open: () =>
      openedSync(owner, () =>
        useRightPanelStore.getState().openFile(owner, path, undefined, { keepExplorer: true }),
      ),
  };
}

/** A chat file chip. A dropped file keeps a standalone Files tab open beside it. */
export function fileChipPanelLink(
  threadRef: ScopedThreadRef | undefined,
  panelPath: string | null | undefined,
  openInPanel: (
    panelPath: string,
    options: OpenFileOptions,
  ) => OpenedSurface | Promise<OpenedSurface>,
): PanelLink | null {
  if (threadRef === undefined || !panelPath) return null;
  return {
    panelRef: rightPanelHostRef(threadRef),
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
  readonly threadRef: ScopedThreadRef | undefined;
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
  readonly openInPreview: () => Promise<OpenedSurface>;
}): PanelLink | null {
  const { href, threadRef } = input;
  if (threadRef === undefined) return null;
  const panelRef = rightPanelHostRef(threadRef);
  if (href.startsWith("board://")) {
    return input.boardInPanel()
      ? { panelRef, open: () => openedSync(panelRef, input.showBoard) }
      : null;
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
      const opened = changeRequest ? openedSync(panelRef, input.openChangeRequest) : null;
      if (opened !== null || !input.canOpenInPreview) return opened;
      return input.openInPreview();
    },
  };
}

/** A thread chip: a same-environment thread opens as a tab; a linked one reads in the panel. */
export function threadChipPanelLink(input: {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly target:
    | { readonly kind: "local"; readonly ref: ScopedThreadRef }
    | { readonly kind: "linked"; readonly target: LinkedThreadTarget };
}): PanelLink | null {
  const { threadRef, target } = input;
  if (threadRef === undefined) return null;
  if (target.kind === "local" && !canOpenThreadInPanel(target.ref, threadRef)) return null;
  const panelRef = rightPanelHostRef(threadRef);
  return {
    panelRef,
    open: () =>
      openedSync(panelRef, () => {
        const store = useRightPanelStore.getState();
        if (target.kind === "local") store.openThread(threadRef, target.ref.threadId);
        else store.openLinkedThread(threadRef, target.target);
      }),
  };
}
