import type { Element, ElementContent, Root, Text } from "hast";

// Each opening bracket is followed by its closing bracket.
const BRACKETS = "（）［］｛｝｟｠｢｣〈〉《》「」『』【】〔〕〖〗〘〙〚〛";
// Brackets and marks that end a clause or quote. Connectors such as `〜`, `－` and `＿` join a name.
const CJK_PUNCTUATION = new RegExp(`[${BRACKETS}、。，．：；！？｡､＂＇〝〞〟]`, "gu");
const LINK_GOES_ON = /^[-./:?#&=_%+~][\p{L}\p{N}]/u;

function pairBrackets(run: string): Map<number, number> {
  const closerAt = new Map<number, number>();
  const open: { index: number; closer: string }[] = [];
  for (const { 0: char, index } of run.matchAll(CJK_PUNCTUATION)) {
    const bracket = BRACKETS.indexOf(char);
    if (bracket === -1) continue;
    if (bracket % 2 === 0) open.push({ index, closer: BRACKETS[bracket + 1]! });
    else {
      const opener = open.pop();
      if (opener?.closer === char) closerAt.set(opener.index, index);
    }
  }
  return closerAt;
}

// `报告（最终版）.md` and `苹果（消歧义）` are names, but `https://example.com/x（已合并）` ends in prose.
const bracketsInName = (link: string, inside: string, after: string) =>
  /[\\/]/.test(link) &&
  !inside.includes("://") &&
  (/\P{ASCII}$/u.test(link) || LINK_GOES_ON.test(after));

function blankRun(run: string): string {
  const closerAt = pairBrackets(run);
  let prose = "";
  let linkStart = 0;
  let keptUntil = 0;
  for (const { index } of run.matchAll(CJK_PUNCTUATION)) {
    if (index < keptUntil) continue;
    const closer = closerAt.get(index);
    if (
      closer !== undefined &&
      bracketsInName(run.slice(linkStart, index), run.slice(index, closer), run.slice(closer + 1))
    ) {
      keptUntil = closer + 1;
      continue;
    }
    prose += run.slice(linkStart, index) + " ";
    linkStart = index + 1;
  }
  return prose + run.slice(linkStart);
}

/** Blanks the CJK punctuation that ends a link, keeping offsets, so link patterns stop there. */
export function blankCjkPunctuation(line: string): string {
  return line.search(CJK_PUNCTUATION) === -1 ? line : line.replace(/\S+/gu, blankRun);
}

const count = (text: string, char: string) => text.split(char).length - 1;

// GFM's parser drops these from the end of a bare link, and a `)` without its `(`. `_` and `~`
// stay, as in remarkKeepAutolinkSuffixes.
const LINK_TRAIL = /(?:[!"'*,.:;?\]]|&[a-z]+;)$/i;

function trimTrailingPunctuation(url: string): string {
  let kept = url;
  while (true) {
    const unbalanced = kept.endsWith(")") && count(kept, ")") > count(kept, "(");
    const trail = unbalanced ? ")" : LINK_TRAIL.exec(kept)?.[0];
    if (!trail) return kept;
    kept = kept.slice(0, -trail.length);
  }
}

const URL_PREFIX = /^(?:https?:\/\/|www\.)/i;
// GFM's parser starts an http link after anything but an ASCII letter. `www.` is here so a URL
// inside it stays inside.
const URL_START = /(?<![a-z])https?:\/\/|(?<![\p{L}\p{N}])www\./iu;

/** Where a bare link ends: CJK punctuation or any whitespace, then GFM's trailing trim. */
export function bareLinkEnd(url: string): string {
  const cut = blankCjkPunctuation(url).search(/\s/u);
  return trimTrailingPunctuation(cut === -1 ? url : url.slice(0, cut));
}

// As Words and wordsHast escape a destination; GFM links `www.` as http.
const hrefOf = (url: string) =>
  (/^www\./i.test(url) ? `http://${url}` : url).replace(/[^\x21-\x7e]+|[\\[\]`{}|^"<>]/gu, (run) =>
    encodeURIComponent(run),
  );

const text = (value: string): Text => ({ type: "text", value });

const anchor = (url: string): Element => ({
  type: "element",
  tagName: "a",
  properties: { href: hrefOf(url) },
  children: [text(url)],
});

/** Links the URLs in text cut off a bare link, each ended as bareLinkEnd ends it. */
function linkRest(rest: string): ElementContent[] {
  const parts: ElementContent[] = [];
  let plain = "";
  let remaining = rest;
  while (remaining !== "") {
    const found = URL_START.exec(remaining);
    if (found === null) break;
    const url = bareLinkEnd(remaining.slice(found.index));
    // A bare `https://` or `www.` has no destination, so it stays text.
    if (url.length <= found[0].length) {
      plain += remaining.slice(0, found.index + found[0].length);
      remaining = remaining.slice(found.index + found[0].length);
      continue;
    }
    plain += remaining.slice(0, found.index);
    if (plain !== "") parts.push(text(plain));
    plain = "";
    parts.push(anchor(url));
    remaining = remaining.slice(found.index + url.length);
  }
  plain += remaining;
  if (plain !== "") parts.push(text(plain));
  return parts;
}

/** Cuts one of Words' bare links at CJK punctuation, returning what follows it, or null. */
function cutBareLink(link: Element, source: string): ElementContent[] | null {
  const label = link.children.length === 1 ? link.children[0] : undefined;
  const start = link.position?.start.offset;
  const end = link.position?.end.offset;
  if (label?.type !== "text" || start === undefined || end === undefined) return null;
  // `<url>` and `[url](url)` were ended by their author.
  if (!URL_PREFIX.test(label.value) || source.slice(start, end) !== label.value) return null;
  const kept = bareLinkEnd(label.value);
  if (kept === label.value) return null;
  label.value = kept;
  link.properties.href = hrefOf(kept);
  const position = link.position!;
  // A bare link never spans lines.
  link.position = {
    start: position.start,
    end: {
      line: position.start.line,
      column: position.start.column + kept.length,
      offset: start + kept.length,
    },
  };
  return linkRest(source.slice(start + kept.length, end));
}

/**
 * Words ends a bare link at CJK punctuation only when the URL is ASCII up to it, and links across
 * U+3000. This ends the rest of Words' bare links where bareLinkEnd does.
 */
export function endLinksAtCjkPunctuation(tree: Root, source: string): void {
  const visit = (node: Root | Element) => {
    const children = node.children as ElementContent[];
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!;
      if (child.type !== "element") continue;
      if (child.tagName === "a") {
        const rest = cutBareLink(child, source);
        if (rest) {
          children.splice(index + 1, 0, ...rest);
          index += rest.length;
        }
      } else if (child.tagName !== "code" && child.tagName !== "pre" && child.tagName !== "svg") {
        visit(child);
      }
    }
  };
  visit(tree);
}
