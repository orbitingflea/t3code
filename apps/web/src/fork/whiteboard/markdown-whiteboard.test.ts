import { describe, expect, it } from "vite-plus/test";

import { boardMentionParts, remarkWhiteboardLinks } from "./markdown-whiteboard";

describe("remarkWhiteboardLinks", () => {
  it("links bare board URLs but leaves existing links and code alone", () => {
    const tree = {
      type: "root",
      children: [
        { type: "text", value: "See board://r/1,2,3,4." },
        { type: "link", url: "board://r/5,6,7,8", children: [{ type: "text", value: "Area 1" }] },
        { type: "inlineCode", value: "board://r/9,10,11,12" },
      ],
    };

    remarkWhiteboardLinks()(tree);
    expect(tree.children).toEqual([
      { type: "text", value: "See " },
      {
        type: "link",
        url: "board://r/1,2,3,4",
        children: [{ type: "text", value: "board://r/1,2,3,4" }],
      },
      { type: "text", value: "." },
      { type: "link", url: "board://r/5,6,7,8", children: [{ type: "text", value: "Area 1" }] },
      { type: "inlineCode", value: "board://r/9,10,11,12" },
    ]);
  });
});

describe("boardMentionParts", () => {
  it.each<[string, ReturnType<typeof boardMentionParts>]>([
    ["[Area 1](board://r/1053,38,771,582)", { label: "Area 1", href: "board://r/1053,38,771,582" }],
    ["[Area \\[1\\]](board://r/1,2,3,4)", { label: "Area [1]", href: "board://r/1,2,3,4" }],
    ["[](board://r/1,2,3,4)", { label: "board://r/1,2,3,4", href: "board://r/1,2,3,4" }],
    ["board://r/1,2,3,4", { label: "board://r/1,2,3,4", href: "board://r/1,2,3,4" }],
    ["[x](board://)", { label: "x", href: "board://" }],
    ["src/a.ts", null],
    ["[a.ts](src/a.ts)", null],
    ["[Area 1](board://r/1,2", null],
    ["[Area 1](board://r/1,2,3,4) and more", null],
  ])("reads %j", (mention, expected) => {
    expect(boardMentionParts(mention)).toEqual(expected);
  });
});
