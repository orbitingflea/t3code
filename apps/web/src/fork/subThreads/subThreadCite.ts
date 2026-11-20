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
import { shownSurfaces } from "../workArea/workAreaGeometry.logic";
import { currentWorkAreaView } from "../workArea/workAreaView";
import { openSubThread, type SubThreadSummary, useSubThreadSummaries } from "./subThreadsState";

type CiteComposer = RefObject<Pick<
  ChatComposerHandle,
  "readSnapshot" | "citeAssistantText"
> | null>;

interface ReplyBox {
  readonly first: string;
  readonly composer: CiteComposer;
}

const replyBoxByThreadKey = new Map<string, ReplyBox>();

export function registerReplyBox(
  threadKey: string,
  first: string,
  composer: CiteComposer,
): () => void {
  const box = { first, composer };
  replyBoxByThreadKey.set(threadKey, box);
  return () => {
    if (replyBoxByThreadKey.get(threadKey) === box) replyBoxByThreadKey.delete(threadKey);
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

export function citeInThread(
  threadRef: ScopedThreadRef,
  cited: string,
  own: CiteComposer,
  citation: AssistantCitation,
  sourceAnchor: AssistantCitationSourceAnchor,
): boolean {
  if (hasText(own)) return citeInto(own, citation, sourceAnchor);
  const threadKey = scopedThreadKey(threadRef);
  // Any drawn pane: a Cite from the chat leaves Replies in a pane the user is not working in.
  const repliesOnScreen = shownSurfaces(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
    currentWorkAreaView(),
  ).some((surface) => surface.kind === "replies");
  const shown = repliesOnScreen ? replyBoxByThreadKey.get(threadKey) : undefined;
  if (shown && hasText(shown.composer)) return citeInto(shown.composer, citation, sourceAnchor);
  if (shown?.first !== cited) {
    // A user open, so a waiting automatic Diff cannot replace it. A sync commit runs its passive
    // effects before returning, so the box has loaded its draft.
    flushSync(() => openSubThread(threadRef, cited));
  }
  const box = replyBoxByThreadKey.get(threadKey);
  if (box?.first !== cited) {
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
