import { useEffect, type RefObject } from "react";

import type { ComposerPromptEditorHandle } from "../../components/ComposerPromptEditorTiptap";
import { useInSubThreadView } from "../subThreads/subThreadsState";
import { isEmbeddedInWhiteboard } from "./build";

// The board sends the reference of a region the user picked; it lands at the caret as its own word.
export function useWhiteboardInsertRef(
  editorRef: RefObject<ComposerPromptEditorHandle | null>,
  promptRef: RefObject<string>,
  applyPromptReplacement: (rangeStart: number, rangeEnd: number, replacement: string) => unknown,
) {
  const inSubThreadView = useInSubThreadView();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window message listener for the board page's insert requests, held while mounted
  useEffect(() => {
    if (!isEmbeddedInWhiteboard()) return;
    const insertWhiteboardRef = (event: MessageEvent) => {
      const { type, ref } = (event.data ?? {}) as { type?: string; ref?: string };
      if (event.source !== window.parent || type !== "wb-insert-ref" || !ref) return;
      // With a sub-thread open, the thread has two composers. The one that has focus, or had it
      // before the user went to the board, takes the reference.
      const focusInSubThread = document.activeElement?.closest("[data-sub-thread-view]") != null;
      if (focusInSubThread !== inSubThreadView) return;
      const snapshot = editorRef.current?.readSnapshot();
      const cursor =
        snapshot?.value === promptRef.current ? snapshot.expandedCursor : promptRef.current.length;
      const spaced =
        cursor > 0 && !/\s/.test(promptRef.current[cursor - 1] ?? "") ? ` ${ref}` : ref;
      applyPromptReplacement(cursor, cursor, `${spaced} `);
    };
    window.addEventListener("message", insertWhiteboardRef);
    return () => window.removeEventListener("message", insertWhiteboardRef);
  }, [applyPromptReplacement, editorRef, inSubThreadView, promptRef]);
}
