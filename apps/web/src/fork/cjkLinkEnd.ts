import type { Link, Nodes, Paragraph, PhrasingContent, Root, Text } from "mdast";
import type { Transform } from "mdast-util-from-markdown";
import type { Processor } from "unified";
import type { VFile } from "vfile";

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

/** Cuts a bare link at CJK punctuation and returns the cut-off text, or nothing to cut. */
function cutBareLink(link: Link, source: string): Text | undefined {
  const label = link.children.length === 1 ? link.children[0] : undefined;
  if (label?.type !== "text") return undefined;
  const scheme = link.url === `http://${label.value}` ? "http://" : "";
  if (link.url !== scheme + label.value) return undefined;
  const cut = blankCjkPunctuation(label.value).indexOf(" ");
  if (cut === -1) return undefined;
  const { position } = link;
  // `<url>` and `[url](url)` were ended by their author.
  if (position && source.slice(position.start.offset, position.end.offset) !== label.value) {
    return undefined;
  }
  const kept = trimTrailingPunctuation(label.value.slice(0, cut));
  const rest: Text = { type: "text", value: label.value.slice(kept.length) };
  label.value = kept;
  link.url = scheme + kept;
  if (position?.start.offset !== undefined) {
    // A bare link never spans lines.
    const boundary = {
      line: position.start.line,
      column: position.start.column + kept.length,
      offset: position.start.offset + kept.length,
    };
    rest.position = { start: boundary, end: position.end };
    link.position = { start: position.start, end: boundary };
    label.position = link.position;
  }
  return rest;
}

// GFM's parser starts an http link after anything but an ASCII letter. Its transform, which is what
// can run on a text node, needs punctuation first. `www.` is here so a URL inside it stays inside.
const URL_START = /(?<![a-z])https?:\/\/|(?<![\p{L}\p{N}])www\./iu;

/**
 * GFM ends a bare link only at whitespace or `<`, so in `（https://example.com/a），然后` the link takes
 * `），然后`. This ends bare links at CJK punctuation and links URLs in the cut-off text as GFM does.
 */
export function remarkEndLinksAtCjkPunctuation(this: Processor) {
  const autolinkTransforms: Transform[] = (this.data().fromMarkdownExtensions ?? [])
    .flat()
    .flatMap((extension) => (extension.enter?.literalAutolink ? (extension.transforms ?? []) : []));
  const linkUrls = (text: Text): PhrasingContent[] => {
    const start = text.value.search(URL_START);
    if (start === -1) return [text];
    // The transform accepts a URL at the start of a text node. Later URLs are found when this link
    // is cut in turn.
    const paragraph: Paragraph = {
      type: "paragraph",
      children: [
        { type: "text", value: text.value.slice(0, start) },
        { type: "text", value: text.value.slice(start) },
      ],
    };
    for (const transform of autolinkTransforms) transform({ type: "root", children: [paragraph] });
    return paragraph.children;
  };
  return (tree: Root, file: VFile) => {
    const source = String(file);
    const visit = (node: Nodes) => {
      if (!("children" in node) || node.type === "link" || node.type === "linkReference") return;
      for (let index = 0; index < node.children.length; index++) {
        const child = node.children[index]!;
        const rest = child.type === "link" ? cutBareLink(child, source) : undefined;
        if (rest) (node.children as PhrasingContent[]).splice(index + 1, 0, ...linkUrls(rest));
        else visit(child);
      }
    };
    visit(tree);
  };
}
