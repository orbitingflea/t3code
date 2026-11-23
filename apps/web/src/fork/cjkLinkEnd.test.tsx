import type { Element, Root } from "hast";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast, type WordsHastOptions } from "../markdown/wordsHast";

const CHAT: WordsHastOptions = {
  math: false,
  breaks: false,
  escapeHtml: false,
  insights: false,
  extensions: {},
  boardLinks: true,
};

const URI_ESCAPE = /%[0-9A-F]{2}/i;

function anchors(source: string) {
  const found: Array<{ href: string; text: string }> = [];
  const visit = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (child.tagName === "a") {
        const text = child.children
          .map((part) => (part.type === "text" ? part.value : ""))
          .join("");
        const href = String(child.properties.href);
        found.push({ href: URI_ESCAPE.test(href) ? decodeURI(href) : href, text });
      } else visit(child);
    }
  };
  visit(wordsHast(source, CHAT));
  return found;
}

const bare = (href: string, text = href) => ({ href, text });

describe("endLinksAtCjkPunctuation", () => {
  it.each([
    ["（https://example.com/pull/78），Claude 和", [bare("https://example.com/pull/78")]],
    [
      "补的测试已合并（https://example.com/t3code/pull/78），Claude 和 Codex 都覆盖到了。",
      [bare("https://example.com/t3code/pull/78")],
    ],
    [
      "tools 的 #109（https://example.com/tools/pull/109）修的是 lint",
      [bare("https://example.com/tools/pull/109")],
    ],
    ["见 www.example.com/a。下一句", [bare("http://www.example.com/a", "www.example.com/a")]],
    [
      "两个：https://example.com/a、https://example.com/b；完",
      [bare("https://example.com/a"), bare("https://example.com/b")],
    ],
    ["（see https://example.com/a)，然后", [bare("https://example.com/a")]],
    ['"https://example.com/a"，然后', [bare("https://example.com/a")]],
    [
      "https://example.com/a，另见https://example.com/b，又见https://example.com/c",
      ["a", "b", "c"].map((path) => bare(`https://example.com/${path}`)),
    ],
    [
      "https://example.com/a，另见https://example.com/b?u=https://example.com/c",
      [bare("https://example.com/a"), bare("https://example.com/b?u=https://example.com/c")],
    ],
    ["https://example.com/a，见xhttps://example.com/b", [bare("https://example.com/a")]],
    ["https://example.com/a，见www.example.com/b", [bare("https://example.com/a")]],
    ["https://example.com/中文，见https://", [bare("https://example.com/中文")]],
    [
      "https://example.com/中文，见https://example.com/b]",
      [bare("https://example.com/中文"), bare("https://example.com/b")],
    ],
    [
      "「https://example.com/a」『https://example.com/b』【https://example.com/c】《https://example.com/d》",
      ["a", "b", "c", "d"].map((path) => bare(`https://example.com/${path}`)),
    ],
    [
      "好！https://example.com/a！真的？https://example.com/b？",
      [bare("https://example.com/a"), bare("https://example.com/b")],
    ],
    ["看 https://example.com/a\u{3000}下一句", [bare("https://example.com/a")]],
    ["看 board://r/1,2,3,4），好", [bare("board://r/1,2,3,4")]],
    ["见 https://example.com/pull/78（已合并）。", [bare("https://example.com/pull/78")]],
    [
      "见 https://example.com/wiki/苹果（消歧义），然后",
      [bare("https://example.com/wiki/苹果（消歧义）")],
    ],
    [
      "（https://example.com/wiki/苹果（消歧义）），然后",
      [bare("https://example.com/wiki/苹果（消歧义）")],
    ],
  ])("ends the bare link at CJK punctuation in %j", (source, links) => {
    expect(anchors(source)).toEqual(links);
  });

  it.each([...`!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`, "&amp;"])(
    "ends a link after %j at CJK punctuation as GFM ends it at a space",
    (trail) => {
      const link = `https://example.com/a${trail}`;
      expect(anchors(`见 ${link}，然后`)).toEqual(anchors(`见 ${link} 然后`));
    },
  );

  it.each([
    ["见 https://example.com/wiki/中文 页", [bare("https://example.com/wiki/中文")]],
    [
      "见 https://example.com/wiki/苹果（消歧义）",
      [bare("https://example.com/wiki/苹果（消歧义）")],
    ],
    ["(see https://example.com/a), then", [bare("https://example.com/a")]],
    [
      "see https://example.com/a_(b) and https://example.com/c.",
      [bare("https://example.com/a_(b)"), bare("https://example.com/c")],
    ],
    ["<https://example.com/a），b>", [bare("https://example.com/a），b")]],
    ["[链接](https://example.com/a)，然后", [bare("https://example.com/a", "链接")]],
  ])("leaves links that need no CJK ending as they were: %j", (source, links) => {
    expect(anchors(source)).toEqual(links);
  });

  // Words' own autolink boundaries end these first, and the fork pass leaves them as they are.
  it.each([
    ["[https://example.com/a]，然后", []],
    [
      "https://example.com/a，www.example.com/b?u=https://example.com/c",
      [
        bare("https://example.com/a"),
        bare(
          "http://www.example.com/b?u=https://example.com/c",
          "www.example.com/b?u=https://example.com/c",
        ),
      ],
    ],
    ["见 https://example.com/report（1）.pdf 页", [bare("https://example.com/report")]],
  ])("keeps upstream's ending of %j", (source, links) => {
    expect(anchors(source)).toEqual(links);
  });
});
