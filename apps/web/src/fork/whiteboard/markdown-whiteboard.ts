// A board reference is a `board://r/x,y,w,h` URL naming a rectangle on the
// whiteboard that embeds this app. Rendered chat text turns those URLs into
// links that point at the board instead of at a page.
export { postWhiteboardHover } from "./boardChannel";

type MarkdownNode = {
  type?: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const BOARD_URL_REGEX = /board:\/\/[^\s<>]+/g;

/** Autolink bare board URLs in prose, leaving existing links and code alone. */
export function remarkWhiteboardLinks() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "link" || node.type === "code" || node.type === "inlineCode") return;
      if (node.children) {
        node.children = node.children.flatMap((child) => {
          if (child.type !== "text" || !child.value?.includes("board://")) {
            visit(child);
            return child;
          }
          const children: MarkdownNode[] = [];
          let cursor = 0;
          for (const match of child.value.matchAll(BOARD_URL_REGEX)) {
            const start = match.index ?? 0;
            const url = (match[0] ?? "").replace(/[),.;!?]+$/, "");
            if (start > cursor)
              children.push({ type: "text", value: child.value.slice(cursor, start) });
            children.push({ type: "link", url, children: [{ type: "text", value: url }] });
            cursor = start + url.length;
          }
          if (cursor < child.value.length)
            children.push({ type: "text", value: child.value.slice(cursor) });
          return children;
        });
      }
    };
    visit(tree);
  };
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
