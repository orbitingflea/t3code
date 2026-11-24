import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { HTMLAttributes, SyntheticEvent } from "react";

import { useThreadFindOpen, useThreadFindStore } from "~/components/chat/threadFindStore";
import { shouldRenderPreviewMiniPlayer } from "~/components/ChatView.logic";
import type { PreviewMiniPlayerSource } from "~/previewMiniPlayerStore";
import {
  selectThreadRightPanelState,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import { panelHostedElsewhere } from "./chatFileOpener";
import { findOpensThreadPage } from "./findOpensThread";
import {
  focusedTab,
  paneHolding,
  PRIMARY_CHAT,
  resolveLayout,
  type WorkAreaLayout,
} from "./workArea.logic";
import {
  chatColumnBox,
  type CssBox,
  isStripView,
  primaryChatRect,
  shownSurfaces,
} from "./workAreaGeometry.logic";
import { currentWorkAreaView, drawModeView, useStripView } from "./workAreaView";

// The column's box comes from its style, so it can be its own layout root, as the panes are (WorkArea.tsx).
const PANE_COLUMN_CLASS =
  "absolute z-[1] contain-size contain-layout @container/chat [&>[data-chat-header]]:[-webkit-app-region:no-drag]! [&>[data-chat-header]]:pl-(--workspace-gutter-start)! [&>[data-chat-header]]:h-9! [&>[data-chat-header]]:min-h-9!";

type ChatColumnFocus = Pick<
  HTMLAttributes<HTMLElement>,
  "onPointerDownCapture" | "onKeyDownCapture" | "onFocus"
>;

interface ChatColumnPlacement {
  readonly className: string;
  readonly style: CssBox | undefined;
  /** No pane shows primary Chat. The column is mounted and hidden, but its Find bar may show. */
  readonly away: boolean;
  readonly inert: boolean;
}

const DOCKED: ChatColumnPlacement = {
  className: "flex-1",
  style: undefined,
  away: false,
  inert: false,
};
const AWAY: ChatColumnPlacement = {
  className: "absolute top-0 left-0 h-full w-0 contain-size contain-layout",
  style: undefined,
  away: true,
  inert: true,
};
// One strip draws a reply of the thread whose Find is open: only the Find bar shows, over the reply.
const FIND_OVER: ChatColumnPlacement = {
  className: `${PANE_COLUMN_CLASS} invisible [&_[data-thread-find-bar]]:visible`,
  style: chatColumnBox({ x: 0, y: 0, w: 1, h: 1 }),
  away: true,
  inert: false,
};

// One strip draws a reply of `thread`, which Find covers with its bar instead of showing the Chat.
const replyUnderFind = (layout: WorkAreaLayout, strip: boolean, thread: ScopedThreadRef) => {
  const reply = layout.tabs[focusedTab(layout)];
  return (
    strip &&
    reply?.kind === "sub-thread" &&
    scopedThreadKey(reply.thread) === scopedThreadKey(thread)
  );
};

let followingFind = false;

// Find searches the primary Chat, so each request shows it, unless it searches the Chat in place
// as another thread's side Chat. Zustand runs this inside `set`, before the Find field's focus
// effect, which focuses nothing in an inert column.
export function followFindRequests(): void {
  if (followingFind) return;
  followingFind = true;
  useThreadFindStore.subscribe((next, previous) => {
    if (next.focusRequestId === previous.focusRequestId || next.threadKey === null) return;
    const thread = parseScopedThreadKey(next.threadKey);
    if (thread === null || (panelHostedElsewhere(thread) && !findOpensThreadPage(next.threadKey)))
      return;
    const store = useRightPanelStore.getState();
    const layout = resolveLayout(selectThreadRightPanelState(store.byThreadKey, thread));
    const view = currentWorkAreaView();
    if (primaryChatRect(layout, view) !== null) return;
    if (replyUnderFind(layout, isStripView(layout, view), thread)) return;
    store.updateWorkArea(thread, { type: "open-thread", thread });
  });
}

function focusChatPane(owner: ScopedThreadRef) {
  const store = useRightPanelStore.getState();
  const layout = resolveLayout(selectThreadRightPanelState(store.byThreadKey, owner));
  const pane = paneHolding(layout.root, PRIMARY_CHAT);
  if (pane && pane.active === PRIMARY_CHAT && pane.id !== layout.focused) {
    store.updateWorkArea(owner, { type: "focus", pane: pane.id });
  }
}

// React also delivers events from portals opened inside the column; those are not presses on it.
const inColumn = (event: SyntheticEvent<HTMLElement>) =>
  event.target instanceof Node && event.currentTarget.contains(event.target);

const chatColumnFocus = (owner: ScopedThreadRef): ChatColumnFocus => ({
  // The pane rule: the primary button, and thumb buttons so back and forward reach this pane.
  onPointerDownCapture: (event) => {
    if (inColumn(event) && (event.button === 0 || event.button === 3 || event.button === 4)) {
      focusChatPane(owner);
    }
  },
  onKeyDownCapture: (event) => {
    if (inColumn(event)) focusChatPane(owner);
  },
  // Focus from a pane is a keyboard move; the app's own composer focus leaves the panes alone.
  onFocus: (event) => {
    const from = event.relatedTarget;
    const area = event.currentTarget.parentElement?.querySelector(":scope > [data-work-area]");
    if (inColumn(event) && from instanceof Node && area?.contains(from)) focusChatPane(owner);
  },
});

/**
 * Placement and pane-focus handlers for ChatView's column, plus whether the mini player shows. An
 * embedded ChatView has no work area and keeps its docked column.
 */
export function useWorkAreaChat(
  record: ThreadRightPanelState,
  embedded: boolean,
  thread: ScopedThreadRef | null,
  miniPlayer: PreviewMiniPlayerSource | null,
): {
  readonly column: ChatColumnPlacement;
  readonly columnFocus: ChatColumnFocus;
  readonly miniPlayerVisible: boolean;
} {
  const layout = resolveLayout(record);
  const strip = useStripView(layout);
  const findOpen = useThreadFindOpen(thread, !embedded);
  const playable = shouldRenderPreviewMiniPlayer(miniPlayer, null);
  if (embedded) return { column: DOCKED, columnFocus: {}, miniPlayerVisible: playable };
  const drawn = drawModeView(strip);
  const rect = primaryChatRect(layout, drawn);
  const findOver = findOpen && thread !== null && replyUnderFind(layout, strip, thread);
  return {
    column: rect
      ? { className: PANE_COLUMN_CLASS, style: chatColumnBox(rect), away: false, inert: false }
      : findOver
        ? FIND_OVER
        : AWAY,
    columnFocus: thread === null ? {} : chatColumnFocus(thread),
    miniPlayerVisible:
      playable &&
      shownSurfaces(record, drawn).every((surface) =>
        shouldRenderPreviewMiniPlayer(miniPlayer, surface),
      ),
  };
}
