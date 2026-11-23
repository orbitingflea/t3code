import { toHtml } from "hast-util-to-html";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast, type WordsHastOptions } from "../../markdown/wordsHast";

const CHAT: WordsHastOptions = {
  math: false,
  breaks: false,
  escapeHtml: false,
  insights: false,
  extensions: {},
  boardLinks: true,
};

describe("linkBoardUrls", () => {
  const source = "See board://r/1,2,3,4. [Area 1](board://r/5,6,7,8) `board://r/9,10,11,12`";

  it("links bare board URLs but leaves existing links and code alone", () => {
    expect(toHtml(wordsHast(source, CHAT))).toBe(
      '<p dir="ltr">See <span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><a href="board://r/1,2,3,4">board://r/1,2,3,4</a>.</span> <a href="board://r/5,6,7,8">Area 1</a> <code data-inline-code="" dir="ltr">board://r/9,10,11,12</code></p>',
    );
  });

  it("leaves bare board URLs as text without boardLinks, as on the Dashboard", () => {
    expect(toHtml(wordsHast(source, { ...CHAT, boardLinks: false }))).toContain(
      "See board://r/1,2,3,4. ",
    );
  });
});
