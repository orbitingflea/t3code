// A board reference is a `board://r/x,y,w,h` URL naming a rectangle on the
// whiteboard that embeds this app. Rendered chat text turns those URLs into
// links that point at the board instead of at a page.
import type { Element, ElementContent, Root } from "hast";

import { bareLinkEnd } from "../cjkLinkEnd";

const BOARD_URL = /board:\/\/[^\s<>]+/g;

function linkText(value: string): ElementContent[] {
  const parts: ElementContent[] = [];
  const pattern = new RegExp(BOARD_URL);
  let cursor = 0;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    // A URL cut at CJK punctuation lets the next one start after it.
    const url = bareLinkEnd(match[0]).replace(/[),.;!?]+$/, "");
    if (match.index > cursor) parts.push({ type: "text", value: value.slice(cursor, match.index) });
    parts.push({
      type: "element",
      tagName: "a",
      properties: { href: url },
      children: [{ type: "text", value: url }],
    });
    cursor = match.index + url.length;
    pattern.lastIndex = cursor;
  }
  if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
  return parts;
}

/** Links bare board URLs in prose, leaving links, code and math alone. */
export function linkBoardUrls(tree: Root | Element): void {
  const children = tree.children as ElementContent[];
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type === "text" && child.value.includes("board://")) {
      const parts = linkText(child.value);
      children.splice(index, 1, ...parts);
      index += parts.length - 1;
    } else if (
      child.type === "element" &&
      child.tagName !== "a" &&
      child.tagName !== "code" &&
      child.tagName !== "pre" &&
      child.tagName !== "svg"
    ) {
      linkBoardUrls(child);
    }
  }
}

// The board mentions the composer tokenizer makes: `[label](board://...)` with `\` escapes in the
// label and any destination it accepts that starts `board://`, and a bare `board://...`.
const BOARD_MENTION_REGEX = /^(?:\[((?:\\.|[^\]\\])*)\]\((board:\/\/[^)\s]*)\)|(board:\/\/\S*))$/;

/** A composer mention's board reference and the label its chip shows; null for a path. */
export function boardMentionParts(mention: string): { label: string; href: string } | null {
  const match = BOARD_MENTION_REGEX.exec(mention);
  const href = match?.[2] ?? match?.[3];
  if (match === null || href === undefined) return null;
  const label = match[1]?.replace(/\\(.)/g, "$1");
  return { label: label || href, href };
}
