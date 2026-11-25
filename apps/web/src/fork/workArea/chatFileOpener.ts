import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { createContext, use } from "react";

import { toastManager } from "~/components/ui/toast";
import { WORK_AREA_COPY } from "~/fork/forkCopy";
import type { SideChatParentPanel } from "~/lib/sideChatPane";
import { requestWorkspaceFocus } from "~/lib/workspaceFocus";
import {
  hostRightPanel,
  type OpenFileOptions,
  rightPanelHostRef,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import type { ChatFileAttachment } from "~/types";

import { replyHasDraft } from "../subThreads/subThreadReply";
import { showBoardRef } from "../whiteboard/boardChannel";
import { boardMentionParts } from "../whiteboard/markdown-whiteboard";
import { readThreadProjectRoot } from "../whiteboard/role";
import {
  PRIMARY_CHAT,
  replyTabId,
  resolveLayout,
  surfaceTabId,
  type TabId,
} from "./workArea.logic";
import { userTabMove } from "./tabMoveScope";
import { tabShown } from "./workAreaGeometry.logic";
import type { WorkAreaChange } from "./workAreaPlacement.logic";
import { runOpen } from "./workAreaCommands";
import { captureOpenOrigin, currentWorkAreaView } from "./workAreaView";

type LinkFile = Extract<WorkAreaChange, { type: "link-file" }>;

/**
 * While a secondary Chat or a reply tab of another thread is shown, that thread's panel actions
 * open in the owner's layout. Only on the owner's environment: a pull request or issue tab loads
 * from its record's environment.
 */
export const hostShownChat = (
  thread: ScopedThreadRef,
  owner: ScopedThreadRef,
): (() => void) | undefined =>
  thread.environmentId === owner.environmentId ? hostRightPanel(thread, owner) : undefined;

export const panelHostedElsewhere = (thread: ScopedThreadRef): boolean =>
  scopedThreadKey(rightPanelHostRef(thread)) !== scopedThreadKey(thread);

/** Focuses a reply tab's message box once it is drawn. Reply tab ids are URI-encoded. */
export const focusReplyBox = (tab: TabId) =>
  requestWorkspaceFocus({
    area: "panel",
    selector: `[data-reply-tab="${tab}"] [data-workspace-area="composer"] [contenteditable="true"]`,
  });

/** The tab an open starts in, so what it opens lands beside that tab. */
export type OpenOrigin =
  /** A tab in the opening thread's own layout, its host's for a hosted side chat. */
  | { readonly kind: "own"; readonly tab: TabId; readonly adjacent?: true }
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

// A guest chat's side thread must not run commands in the owner's terminal or use its diff panel.
const GUEST_PANEL: SideChatParentPanel = {};

/**
 * Embedding for a side-thread tab in `owner`'s work area. Side threads of `owner` (or with no
 * parent) use `parentPanel`; those of a hosted Chat open linked files with an empty panel.
 */
export function sideThreadEmbedding(
  threadId: ThreadId,
  listedParent: ThreadId | null,
  owner: ScopedThreadRef,
  parentPanel: SideChatParentPanel,
): { readonly origin: OpenOrigin; readonly parentPanel: SideChatParentPanel } {
  const tab = surfaceTabId(`thread:${threadId}`);
  return listedParent === null || listedParent === owner.threadId
    ? { origin: { kind: "own", tab }, parentPanel }
    : { origin: { kind: "shown", owner, tab }, parentPanel: GUEST_PANEL };
}

function revealedReply(owner: ScopedThreadRef) {
  const layout = resolveLayout(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, owner),
  );
  const payload = layout.revealed === undefined ? undefined : layout.tabs[layout.revealed];
  return payload?.kind === "sub-thread" ? payload : null;
}

/** Runs a store open of `thread`'s panel as one from its primary Chat. */
export const fromPrimaryChat = (thread: ScopedThreadRef, open: () => void) =>
  runOpen({ record: rightPanelHostRef(thread), tab: PRIMARY_CHAT }, open);

export interface ChatFileTarget {
  readonly openFile: (
    ...args: [relativePath: string, line?: number, options?: OpenFileOptions]
  ) => void;
  readonly openAttachment: (attachment: ChatFileAttachment) => void;
  readonly openBoardRef: (href: string) => void;
  /** A composer mention: a whiteboard reference or a workspace path. */
  readonly openMention: (path: string) => void;
  /** Opens `target` as a Chat tab beside the origin, or shows it; false with no origin. */
  readonly openThread: (target: ScopedThreadRef) => boolean;
  /**
   * Opens a sub-thread tab and focuses its reply box. `"find"` keeps focus, shows the tab in
   * another pane if one fits, and covers the origin only in strip view. `"quote"` shows the tab.
   */
  readonly openSubThread: (first: string, options?: { readonly reveal?: "find" | "quote" }) => void;
  // Activates the origin's tab when it is not drawn, as after a Find step drew a reply over it.
  readonly showOrigin: () => void;
  /** The record this target writes to now. */
  readonly panel: () => ScopedThreadRef;
  /** Runs a store open (such as a PR, issue, or browser link) from this chat's origin. */
  readonly run: <T>(open: () => T) => T;
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
  const shown = origin?.kind === "shown" ? origin : null;
  const record = () => shown?.owner ?? rightPanelHostRef(thread);
  const guest = shown?.owner.environmentId === thread.environmentId ? { guest: thread } : {};
  // A drop around the click still places an open that runs after a lookup's await.
  const around = captureOpenOrigin();
  const from = <T>(open: () => T): T =>
    around(() =>
      origin === null
        ? open()
        : runOpen(
            {
              record: record(),
              tab: origin.tab,
              ...(origin.kind === "own" && origin.adjacent ? { adjacent: true } : {}),
              ...guest,
            },
            open,
          ),
    );
  // The user's own open; Find and quote reveals stay on `from`.
  const user = <T>(open: () => T): T => userTabMove(record(), () => from(open));
  const write = (change: WorkAreaChange) => () =>
    useRightPanelStore.getState().updateWorkArea(record(), change);
  const tabs = {
    // With no origin, a thread link stays a navigation.
    openThread: (target: ScopedThreadRef) => {
      if (origin === null) return false;
      user(write({ type: "open-thread", thread: target }));
      return true;
    },
    openSubThread: (first: string, options?: { readonly reveal?: "find" | "quote" }) => {
      if (options?.reveal === undefined) {
        user(write({ type: "open-reply", thread, first }));
        focusReplyBox(replyTabId(thread, first));
        return;
      }
      const revealed = revealedReply(record());
      const keep =
        revealed !== null && replyHasDraft(scopedThreadKey(revealed.thread), revealed.first);
      from(
        write({
          type: "open-reply",
          thread,
          first,
          reveal: options.reveal,
          ...(keep ? { keepRevealed: true } : {}),
        }),
      );
    },
    showOrigin: () => {
      if (origin === null) return;
      const state = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        record(),
      );
      if (!tabShown(resolveLayout(state), currentWorkAreaView(), origin.tab)) {
        from(write({ type: "activate", tab: origin.tab }));
      }
    },
    panel: record,
    run: user,
  };
  if (shown === null) {
    const store = useRightPanelStore.getState();
    return withMention({
      ...tabs,
      openFile: (...args) => user(() => store.openFile(thread, ...args)),
      openAttachment: (attachment) => user(() => store.openAttachment(thread, attachment)),
      openBoardRef: (href) => user(() => showBoardRef(href, thread)),
    });
  }
  const { owner, tab, placement } = shown;
  const placed = placement === undefined ? {} : { from: { tab, placement } };
  const link = (change: Pick<LinkFile, "path" | "line" | "attachment">) =>
    user(write({ type: "link-file", source: thread, ...placed, ...change }));
  return withMention({
    ...tabs,
    openFile: (path, line) => link({ path, line: normalizedLine(line) }),
    openAttachment: (attachment) => link({ path: attachment.name, line: null, attachment }),
    openBoardRef: (href) => {
      // Another project's board is not shown in this layout, and the owner's must not get its region.
      if (!sameBoard(thread, owner)) {
        toastManager.add({ type: "info", title: WORK_AREA_COPY.boardInOtherProject });
        return;
      }
      userTabMove(owner, () =>
        runOpen({ record: rightPanelHostRef(owner), tab }, () => showBoardRef(href, owner)),
      );
    },
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
  userTabMove(owner, () => {
    runOpen({ record: owner, tab }, () => store.openFile(owner, "."));
    store.navigateFolder(owner, "files", relativePath, folderTrail);
  });
}

export const fromChatOrigin = <T>(opener: ChatFileOpener | null, open: () => T): T =>
  opener ? opener().run(open) : open();

export const inChatOrigin =
  <A extends unknown[], T>(opener: ChatFileOpener | null, open: (...args: A) => T) =>
  (...args: A): T =>
    fromChatOrigin(opener, () => open(...args));

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

/**
 * A ChatView's opener and the origin it gives its content: its primary Chat, or its embedding's.
 * Built from the thread's ids, so the compiler keeps one opener while they and the origin hold.
 */
export function useChatViewOpener(
  threadRef: ScopedThreadRef | null | undefined,
  embedded: boolean,
): { readonly origin: OpenOrigin | null; readonly opener: ChatFileOpener | null } {
  const outer = use(OpenOriginContext);
  const origin = embedded ? outer : PRIMARY_CHAT_ORIGIN;
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  const thread = environmentId && threadId ? scopeThreadRef(environmentId, threadId) : null;
  return { origin, opener: chatFileOpener(thread, origin) };
}
