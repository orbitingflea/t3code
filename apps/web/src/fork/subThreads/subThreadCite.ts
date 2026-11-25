import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, ScopedThreadRef } from "@t3tools/contracts";
import type { RefObject } from "react";
import { flushSync } from "react-dom";

import type { ChatComposerHandle } from "../../components/chat/ChatComposer";
import { toastManager } from "../../components/ui/toast";
import { useStableCallback } from "../../hooks/useStableCallback";
import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import type { CiteAssistantText } from "../dashboard/dashboardCitation";
import { useThreadDisplayMode } from "../displayMode/useThreadDisplayMode";
import { chatFileTarget } from "../workArea/chatFileOpener";
import {
  type PaneId,
  PRIMARY_CHAT,
  type ReplyEntry,
  resolveLayout,
} from "../workArea/workArea.logic";
import { type SubThreadSummary, useSubThreadSummaries } from "./subThreadsState";

type CiteComposer = RefObject<Pick<
  ChatComposerHandle,
  "readSnapshot" | "citeAssistantText"
> | null>;

interface ReplyBox {
  readonly threadKey: string;
  readonly first: string;
  /** The reply tab's strip entry: one per tab from its open until its close. */
  readonly tab: ReplyEntry;
  /** The pane of the tab's view; a tab open in two panes has a box in each. */
  readonly pane: PaneId | null;
  readonly composer: CiteComposer;
}

/** The reply boxes on screen: a tab's body mounts only while it is drawn. */
const mountedBoxes = new Set<ReplyBox>();
/** When each reply tab's box last took focus, per pane; a closed and reopened tab starts fresh. */
const focusedAt = new WeakMap<ReplyEntry, Map<PaneId | null, number>>();
let focusCount = 0;

const lastFocus = (box: ReplyBox) => focusedAt.get(box.tab)?.get(box.pane) ?? 0;

// The box focused last; of boxes never focused, the one mounted last.
function focusedLast(boxes: Iterable<ReplyBox>): ReplyBox | undefined {
  let chosen: ReplyBox | undefined;
  for (const box of boxes) {
    if (chosen === undefined || lastFocus(box) >= lastFocus(chosen)) chosen = box;
  }
  return chosen;
}

/**
 * Registers a mounted reply tab's composer for `citeInThread`, keyed by `(tab, pane)` so multiple
 * views of one reply tab track focus order separately. Returns a focus recorder and a disposer.
 */
export function registerReplyBox(
  tab: ReplyEntry,
  threadKey: string,
  first: string,
  composer: CiteComposer,
  pane: PaneId | null = null,
): { readonly focused: () => void; readonly [Symbol.dispose]: () => void } {
  const box: ReplyBox = { threadKey, first, tab, pane, composer };
  mountedBoxes.add(box);
  return {
    focused: () => {
      const times = focusedAt.get(tab) ?? new Map<PaneId | null, number>();
      focusedAt.set(tab, times.set(pane, (focusCount += 1)));
    },
    [Symbol.dispose]: () => mountedBoxes.delete(box),
  };
}

const hasText = (composer: CiteComposer) =>
  (composer.current?.readSnapshot().value ?? "").trim() !== "";

function citeInto(
  composer: CiteComposer,
  citation: AssistantCitation,
  sourceAnchor: AssistantCitationSourceAnchor,
): boolean {
  const inserted = composer.current?.citeAssistantText(citation, sourceAnchor) ?? false;
  if (!inserted) {
    toastManager.add({
      type: "warning",
      title: "The composer is not ready",
      description: "Try citing the selection after the connection or pending input is resolved.",
    });
  }
  return inserted;
}

/**
 * A main-list Cite: the main box when it has text, else the shown reply box with text whose tab
 * was focused last, else the cited message's reply tab, opened or shown.
 */
export function citeInThread(
  threadRef: ScopedThreadRef,
  cited: string,
  own: CiteComposer,
  citation: AssistantCitation,
  sourceAnchor: AssistantCitationSourceAnchor,
): boolean {
  if (hasText(own)) return citeInto(own, citation, sourceAnchor);
  const threadKey = scopedThreadKey(threadRef);
  const drafted = focusedLast(
    [...mountedBoxes].filter((box) => box.threadKey === threadKey && hasText(box.composer)),
  );
  if (drafted) return citeInto(drafted.composer, citation, sourceAnchor);
  // A user open, so a waiting automatic Diff cannot replace it. A sync commit runs its passive
  // effects before returning, so the box has loaded its draft.
  const target = chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, threadRef);
  flushSync(() => target.openSubThread(cited));
  const cites = [...mountedBoxes].filter(
    (candidate) => candidate.threadKey === threadKey && candidate.first === cited,
  );
  // The open focuses the pane it shows the tab in, which a tab open in two panes has a box in.
  const shownIn = resolveLayout(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, target.panel()),
  ).focused;
  const box = cites.find((candidate) => candidate.pane === shownIn) ?? focusedLast(cites);
  if (!box) {
    toastManager.add({ type: "warning", title: "Could not open the reply box" });
    return false;
  }
  return citeInto(box.composer, citation, sourceAnchor);
}

/** A main-list Cite goes to a message's Replies only once it has replies; else it stays in the main box. */
export const citeOpensReplies = (summary: SubThreadSummary | undefined): boolean =>
  (summary?.replies ?? 0) > 0;

export function useSubThreadCite(
  routingThreadRef: ScopedThreadRef | null,
  composer: CiteComposer,
): CiteAssistantText {
  const routes = useThreadDisplayMode(routingThreadRef).subThreads;
  const summaries = useSubThreadSummaries(routes ? routingThreadRef : null);
  return useStableCallback((citation, sourceAnchor) =>
    routingThreadRef !== null && citeOpensReplies(summaries.get(citation.messageId))
      ? citeInThread(routingThreadRef, citation.messageId, composer, citation, sourceAnchor)
      : citeInto(composer, citation, sourceAnchor),
  );
}

/** Kept for `RightPanelSheet`: Cite opens a work-area tab, never the sheet, so focus stays on. */
export const sheetInitialFocus = (): boolean => true;
