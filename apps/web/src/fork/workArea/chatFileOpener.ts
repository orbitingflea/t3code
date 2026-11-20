import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { createContext, use } from "react";

import { hostRightPanel, rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";
import type { ChatFileAttachment } from "~/types";

import { showBoardRef } from "../whiteboard/boardChannel";
import { boardMentionParts } from "../whiteboard/markdown-whiteboard";
import { readThreadProjectRoot } from "../whiteboard/role";
import { PRIMARY_CHAT, surfaceTabId, type TabId } from "./workArea.logic";
import type { WorkAreaChange } from "./workAreaPlacement.logic";
import { runWithOpenOrigin } from "./workAreaView";

type LinkFile = Extract<WorkAreaChange, { type: "link-file" }>;

/**
 * While a secondary Chat is shown, its panel actions open in the owner's layout. Only on the owner's
 * environment: a pull request or issue tab loads from its record's environment.
 */
export const hostShownChat = (thread: ScopedThreadRef, owner: ScopedThreadRef) =>
  thread.environmentId === owner.environmentId ? hostRightPanel(thread, owner) : undefined;

/** The tab an open starts in, so what it opens lands beside that tab. */
export type OpenOrigin =
  /** A tab in the opening thread's own layout, its host's for a hosted side chat. */
  | { readonly kind: "own"; readonly tab: TabId }
  /** A tab of another thread's layout that shows this chat or file. */
  | {
      readonly kind: "shown";
      readonly owner: ScopedThreadRef;
      readonly tab: TabId;
      /** A secondary Chat's placement: its file opens drop once it is closed or placed again. */
      readonly placement?: number;
    };

/** Null outside a chat or a linked file: opens there have no source pane. */
export const OpenOriginContext = createContext<OpenOrigin | null>(null);

const PRIMARY_CHAT_ORIGIN: OpenOrigin = { kind: "own", tab: PRIMARY_CHAT };

export const sideChatOrigin = (threadId: ThreadId): OpenOrigin => ({
  kind: "own",
  tab: surfaceTabId(`side-chat:${threadId}`),
});

/** Runs a store open of `thread`'s panel as one from its primary Chat. */
export const fromPrimaryChat = (thread: ScopedThreadRef, open: () => void) =>
  runWithOpenOrigin({ record: rightPanelHostRef(thread), tab: PRIMARY_CHAT }, open);

interface ChatFileTarget {
  readonly openFile: (...args: [relativePath: string, line?: number]) => void;
  readonly openAttachment: (attachment: ChatFileAttachment) => void;
  readonly openBoardRef: (href: string) => void;
  /** A composer mention: a whiteboard reference or a workspace path. */
  readonly openMention: (path: string) => void;
  /** The record this target writes to now. */
  readonly panel: () => ScopedThreadRef;
}

/**
 * Captures where a file of `thread` (the opener's own thread by default) opens; call it when the
 * click happens, before any lookup.
 */
export type ChatFileOpener = (thread?: ScopedThreadRef) => ChatFileTarget;

const normalizedLine = (line: number | undefined) =>
  line === undefined || !Number.isFinite(line) ? null : Math.max(1, Math.trunc(line));

// One board per project, so a chat shares the shown layout's board only for the same project.
function sameBoard(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  if (left.environmentId !== right.environmentId) return false;
  const root = readThreadProjectRoot(left);
  return root !== null && root === readThreadProjectRoot(right);
}

function withMention(target: Omit<ChatFileTarget, "openMention">): ChatFileTarget {
  return {
    ...target,
    openMention: (path) => {
      const board = boardMentionParts(path);
      if (board) target.openBoardRef(board.href);
      else target.openFile(path);
    },
  };
}

/**
 * Opens in `thread`'s own panel through the store, beside an `own` origin's tab. A `shown` origin
 * opens in the owner's layout beside its tab, files read in `thread`'s project.
 */
export function chatFileTarget(origin: OpenOrigin | null, thread: ScopedThreadRef): ChatFileTarget {
  if (origin?.kind !== "shown") {
    const store = useRightPanelStore.getState();
    const from = (open: () => void) =>
      origin === null
        ? open()
        : runWithOpenOrigin({ record: rightPanelHostRef(thread), tab: origin.tab }, open);
    return withMention({
      openFile: (...args) => from(() => store.openFile(thread, ...args)),
      openAttachment: (attachment) => from(() => store.openAttachment(thread, attachment)),
      openBoardRef: (href) => from(() => showBoardRef(href, thread)),
      panel: () => rightPanelHostRef(thread),
    });
  }
  const { owner, tab, placement } = origin;
  const from = placement === undefined ? {} : { from: { tab, placement } };
  const link = (change: Pick<LinkFile, "path" | "line" | "attachment">) =>
    runWithOpenOrigin({ record: owner, tab }, () =>
      useRightPanelStore
        .getState()
        .updateWorkArea(owner, { type: "link-file", source: thread, ...from, ...change }),
    );
  return withMention({
    openFile: (path, line) => link({ path, line: normalizedLine(line) }),
    openAttachment: (attachment) => link({ path: attachment.name, line: null, attachment }),
    openBoardRef: (href) => {
      // Another project's board is not shown in this layout, and the owner's must not get its region.
      if (!sameBoard(thread, owner)) return;
      runWithOpenOrigin({ record: rightPanelHostRef(owner), tab }, () => showBoardRef(href, owner));
    },
    panel: () => owner,
  });
}

/**
 * A linked file's folder breadcrumb, when its thread works in the owner's workspace: the owner's
 * Files explorer opens beside the linked tab, then moves to that folder in its own slot.
 */
export function openLinkedFolder(
  owner: ScopedThreadRef,
  tab: TabId,
  relativePath: string,
  folderTrail: string,
): void {
  const store = useRightPanelStore.getState();
  runWithOpenOrigin({ record: owner, tab }, () => store.openFile(owner, "."));
  store.navigateFolder(owner, "files", relativePath, folderTrail);
}

const chatFileOpener = (
  threadRef: ScopedThreadRef | null | undefined,
  origin: OpenOrigin | null,
): ChatFileOpener | null =>
  threadRef ? (thread = threadRef) => chatFileTarget(origin, thread) : null;

/** The one way a chat opens a file, an attachment or a board reference. */
export function useChatFileOpener(
  threadRef: ScopedThreadRef | null | undefined,
): ChatFileOpener | null {
  return chatFileOpener(threadRef, use(OpenOriginContext));
}

/** A ChatView's opener and the origin it gives its content: its primary Chat, or its embedding's. */
export function useChatViewOpener(
  threadRef: ScopedThreadRef | null | undefined,
  embedded: boolean,
): { readonly origin: OpenOrigin | null; readonly opener: ChatFileOpener | null } {
  const outer = use(OpenOriginContext);
  const origin = embedded ? outer : PRIMARY_CHAT_ORIGIN;
  return { origin, opener: chatFileOpener(threadRef, origin) };
}
