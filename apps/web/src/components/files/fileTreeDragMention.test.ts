import { describe, expect, it } from "@effect/vitest";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { createFileTreeDragMentionController } from "./fileTreeDragMention.ts";

const makeTransfer = (plainText = "") => {
  const data = new Map<string, string>([["text/plain", plainText]]);
  return {
    setData: (format: string, value: string) => void data.set(format, value),
    getData: (format: string) => data.get(format) ?? "",
    data,
  };
};

const rowNode = (path: string) => ({
  getAttribute: (name: string) => (name === "data-item-path" ? path : null),
});

describe("createFileTreeDragMentionController", () => {
  it("tags a row drag with the mention payload and flags the drag", () => {
    const controller = createFileTreeDragMentionController({});
    const transfer = makeTransfer();
    const row = controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [{}, rowNode("docs/index.md"), {}],
    });
    expect(row).toBe("docs/index.md");
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe("[index.md](docs/index.md)");
    expect(controller.isDragInProgress()).toBe(true);
  });

  it("does not tag drags of selected text from the panel chrome", () => {
    const controller = createFileTreeDragMentionController({});
    const transfer = makeTransfer("selected text");
    expect(
      controller.handleDragStart({ dataTransfer: transfer, composedPath: () => [{}] }),
    ).toBeNull();
    expect(transfer.data.has(COMPOSER_MENTION_DRAG_TYPE)).toBe(false);
    expect(controller.isDragInProgress()).toBe(false);
  });

  it("drags the whole selection when the dragged row is part of it, and names the row", () => {
    const deselected: Array<string> = [];
    const controller = createFileTreeDragMentionController({});
    const deselect = (path: string) => void deselected.push(path);
    controller.handleSelectionChange(["docs/index.md", "docs/api.md", "src/app.ts"]);
    const transfer = makeTransfer();
    const row = controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [rowNode("docs/api.md")],
    });
    expect(row).toBe("docs/api.md");
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe(
      "[index.md](docs/index.md) [api.md](docs/api.md) [app.ts](src/app.ts)",
    );
    controller.handleDragEnd(deselect);
    expect(deselected).toEqual(["docs/index.md", "docs/api.md", "src/app.ts"]);
  });
});
