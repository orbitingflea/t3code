import type { Element, ElementContent, Root } from "hast";

import type { MarkdownExtensions } from "../markdown/wordsHast";
import { endLinksAtCjkPunctuation } from "./cjkLinkEnd";
import { linkBoardUrls } from "./whiteboard/markdown-whiteboard";

/** The fork's flags on wordsHast's options. ChatMarkdown keys its cached options by them. */
export interface ForkWordsOptions {
  /** Agent-authored text: only `~~` strikes (early port of open pingdotgg/t3code#29270). */
  readonly agentText?: boolean;
  /** Bare `board://` URLs link. The Dashboard has no board, so it leaves them as text. */
  readonly boardLinks?: boolean;
  /** Markdown shown inside a line: a sole paragraph renders as its content. */
  readonly inline?: boolean;
}

/** What the user wrote, outside a sent message: a single `~` stays text, as in their message. */
export const USER_TEXT_MARKDOWN: MarkdownExtensions = {
  userMessage: true,
  leadingWhitespace: true,
};

/**
 * Words' parse options the fork sets: a single `~` strikes only outside user and agent text, and
 * emphasis works beside CJK punctuation.
 */
export function forkRenderOptions(
  options: ForkWordsOptions & { readonly extensions: MarkdownExtensions },
): { readonly singleTilde: boolean; readonly cjk: true } {
  return { singleTilde: !options.extensions.userMessage && !options.agentText, cjk: true };
}

const EPS = /(?<=(?:^|[^\\])(?:\\\\)*)\\eps(?![A-Za-z])/g;
// The same length as `\eps`, so every offset Words writes is still an offset into the written text.
const EPS_SHOWN = "{ε }";

/**
 * `\eps` in math as `\varepsilon` draws it, as chat's KaTeX macro did. wordsHast passes its
 * `markdownMathRanges`, so this module needs no runtime import of it.
 */
export function forkSource(
  written: string,
  mathRanges: ((text: string) => ReadonlyArray<{ start: number; end: number }>) | null,
): string {
  if (mathRanges === null || !written.includes("\\eps")) return written;
  let source = "";
  let cursor = 0;
  for (const { start, end } of mathRanges(written)) {
    source += written.slice(cursor, start) + written.slice(start, end).replace(EPS, EPS_SHOWN);
    cursor = end;
  }
  return source + written.slice(cursor);
}

/** Replaces the k-th `{ε }` with `\\eps` where `written[k]` says forkSource swapped it. */
function unswap(text: string, written: ReadonlyArray<boolean>): string {
  let k = 0;
  return text.replaceAll(EPS_SHOWN, (shown) => (written[k++] ? "\\eps" : shown));
}

/**
 * A formula's copy text and label show the TeX as written, not forkSource's swap. Words drops a
 * quote or list prefix from them, so swaps are matched by order, not by offset.
 */
function restoreMathSource(node: Root | Element, written: string, source: string) {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    const svg = child.children[0];
    if (child.properties.dataMarkdownMath === undefined || svg?.type !== "element") {
      restoreMathSource(child, written, source);
      continue;
    }
    const start = svg.position?.start.offset;
    const end = svg.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const swapped: boolean[] = [];
    for (let at = source.indexOf(EPS_SHOWN, start); at !== -1 && at < end;) {
      swapped.push(written.startsWith("\\eps", at));
      at = source.indexOf(EPS_SHOWN, at + EPS_SHOWN.length);
    }
    const label = String(svg.properties.ariaLabel ?? "");
    // The range starts at a fence's opening line, whose info string is not in the label.
    swapped.splice(0, swapped.length - (label.split(EPS_SHOWN).length - 1));
    if (!swapped.includes(true)) continue;
    svg.properties.ariaLabel = unswap(label, swapped);
    const copy = child.properties.dataMarkdownCopy;
    if (typeof copy === "string" && copy.split(EPS_SHOWN).length - 1 === swapped.length) {
      child.properties.dataMarkdownCopy = unswap(copy, swapped);
    }
  }
}

function unwrapSoleParagraph(tree: Root) {
  const blocks = tree.children.filter(
    (child) => !(child.type === "text" && child.value.trim() === ""),
  );
  const [only] = blocks;
  if (blocks.length === 1 && only?.type === "element" && only.tagName === "p") {
    tree.children = only.children as ElementContent[];
  }
}

/** The fork's passes over wordsHast's sanitized tree; `source` is forkSource's output. */
export function forkHast(
  tree: Root,
  written: string,
  source: string,
  options: ForkWordsOptions & { readonly extensions: MarkdownExtensions },
): void {
  if (source !== written) restoreMathSource(tree, written, source);
  if (options.boardLinks && written.includes("board://")) linkBoardUrls(tree);
  if (/\P{ASCII}/u.test(written)) endLinksAtCjkPunctuation(tree, written);
  if (options.inline && !options.extensions.preview) unwrapSoleParagraph(tree);
}
