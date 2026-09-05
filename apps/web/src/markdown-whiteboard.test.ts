import { describe, expect, it } from "vite-plus/test";

import { remarkWhiteboardLinks } from "./markdown-whiteboard";

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
