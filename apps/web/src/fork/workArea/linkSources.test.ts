import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import {
  anchorPanelLink,
  fileChipPanelLink,
  fileRowPanelLink,
  filesTreeOwner,
} from "./linkSources";

const ref = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
const thread = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

const PR = "https://github.com/acme/app/pull/7";

describe("anchorPanelLink", () => {
  it.each<
    [
      string,
      {
        href?: string;
        autolink?: string;
        inPanel?: boolean;
        opens?: boolean;
        preview?: boolean;
        board?: boolean;
      },
      string[] | null,
    ]
  >([
    ["a PR the click opens in the panel", { inPanel: true, preview: true }, ["change request"]],
    [
      "a PR whose open opens nothing falls back to the preview",
      { inPanel: true, opens: false, preview: true },
      ["change request", "preview"],
    ],
    ["a PR the click opens in the panel, no preview", { inPanel: true }, ["change request"]],
    ["a PR the click leaves to the browser, with preview", { preview: true }, ["preview"]],
    ["a PR the click leaves to the browser, no preview", {}, null],
    ["a web link with preview", { href: "https://example.com/a", preview: true }, ["preview"]],
    ["a web link without preview", { href: "https://example.com/a" }, null],
    ["a reference autolink", { autolink: "reference", inPanel: true, preview: true }, null],
    ["a mention autolink", { autolink: "mention", inPanel: true, preview: true }, null],
    ["a commit autolink", { autolink: "commit", inPanel: true, preview: true }, null],
    [
      "a commit URL",
      {
        href: "https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567",
        preview: true,
      },
      null,
    ],
    ["an image link", { href: "https://example.com/a.png", preview: true }, null],
    ["a non-web link", { href: "mailto:a@example.com", preview: true }, null],
    ["a board link the panel shows", { href: "board://region/1", board: true }, ["board"]],
    ["a board link the panel does not show", { href: "board://region/1", preview: true }, null],
  ])("%s", (_case, row, expected) => {
    const calls: string[] = [];
    const link = anchorPanelLink({
      href: row.href ?? PR,
      threadRef: ref,
      autolink: row.autolink ?? "",
      boardInPanel: () => row.board ?? false,
      showBoard: () => {
        calls.push("board");
        useRightPanelStore.getState().openFile(ref, "board");
      },
      changeRequestInPanel: () => row.inPanel ?? false,
      canOpenInPreview: row.preview ?? false,
      openChangeRequest: () => {
        calls.push("change request");
        if (row.opens === false) return false;
        useRightPanelStore.getState().openFile(ref, "pull-request");
        return true;
      },
      openInPreview: async () => {
        calls.push("preview");
      },
    });
    if (expected === null) {
      expect(link).toBeNull();
      return;
    }
    void link?.open();
    expect(calls).toEqual(expected);
  });

  it("is null outside a thread", () => {
    const link = anchorPanelLink({
      href: PR,
      threadRef: undefined,
      autolink: "",
      boardInPanel: () => true,
      showBoard: () => {},
      changeRequestInPanel: () => true,
      canOpenInPreview: true,
      openChangeRequest: () => true,
      openInPreview: async () => {},
    });
    expect(link).toBeNull();
  });
});

describe("fileRowPanelLink", () => {
  const row = (treePath: string) =>
    fileRowPanelLink({
      owner: filesTreeOwner(ref),
      treePath,
      isFile: (path) => path.endsWith(".ts"),
      panelPath: (path) => path,
    });

  it("opens a file row beside the Files explorer and keeps the explorer", () => {
    useRightPanelStore.getState().openFile(ref, ".");

    void row("src/app.ts")?.open();
    expect(thread().activeSurfaceId).toBe("file:src/app.ts");
    expect(thread().surfaces.map((surface) => surface.id)).toEqual(["files", "file:src/app.ts"]);
  });

  it("does not drag a folder row to the panel", () => {
    expect(row("src/")).toBeNull();
  });
});

describe("fileChipPanelLink", () => {
  it("opens the chip's file keeping the Files tab, and needs a thread and a panel path", () => {
    const opens: unknown[] = [];
    const open = (path: string, options: unknown) => {
      opens.push([path, options]);
    };
    expect(fileChipPanelLink(undefined, "a.ts", open)).toBeNull();
    expect(fileChipPanelLink(ref, null, open)).toBeNull();

    void fileChipPanelLink(ref, "a.ts", open)?.open();
    expect(opens).toEqual([["a.ts", { keepExplorer: true }]]);
  });
});

describe("openFile with keepExplorer", () => {
  it("keeps the Files explorer and the line beside the dropped file; a click still replaces it", () => {
    const store = useRightPanelStore.getState();
    store.openFile(ref, ".");

    store.openFile(ref, "src/app.ts", 12, { keepExplorer: true });
    expect(thread().activeSurfaceId).toBe("file:src/app.ts");
    expect(thread().surfaces).toEqual([
      { id: "files", kind: "files" },
      expect.objectContaining({ id: "file:src/app.ts", revealLine: 12 }),
    ]);

    store.openFile(ref, "README.md");
    expect(thread().surfaces.map((surface) => surface.id)).toEqual([
      "file:src/app.ts",
      "file:README.md",
    ]);
  });
});
