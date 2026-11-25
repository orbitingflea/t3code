import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "~/composerDraftStore";

import { focusContextInsertion } from "./contextInsertion";
import { other } from "./workAreaTestKit";

const comment = (id: string) => ({
  id,
  sectionId: "file:a/b.ts",
  sectionTitle: "File comment",
  filePath: "a/b.ts",
  startIndex: 3,
  endIndex: 3,
  rangeLabel: "L4",
  text: "Why?",
  diff: "const x = 1;",
});

// V6: two views of one chat mount two composers of one draft.
describe("context inserted into a draft two composers edit", () => {
  it("goes to the composer focused last, and to the other once that one unmounts", () => {
    const draft = useComposerDraftStore.getState();
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const unmountFirst = draft.setContextInsertionHandler(other, first);
    const unmountSecond = draft.setContextInsertionHandler(other, second);
    try {
      focusContextInsertion(second);
      focusContextInsertion(first);
      draft.addReviewComment(other, comment("c1"));
      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();

      unmountFirst?.();
      draft.addReviewComment(other, comment("c2"));
      expect(second).toHaveBeenCalledOnce();
    } finally {
      unmountFirst?.();
      unmountSecond?.();
      draft.removeReviewComment(other, "c1");
      draft.removeReviewComment(other, "c2");
    }
  });

  it("goes to the composer mounted last while neither was focused", () => {
    const draft = useComposerDraftStore.getState();
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const unmountFirst = draft.setContextInsertionHandler(other, first);
    const unmountSecond = draft.setContextInsertionHandler(other, second);
    try {
      draft.addReviewComment(other, comment("c3"));
      expect(second).toHaveBeenCalledOnce();
      expect(first).not.toHaveBeenCalled();
    } finally {
      unmountFirst?.();
      unmountSecond?.();
      draft.removeReviewComment(other, "c3");
    }
  });
});
