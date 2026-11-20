import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  hostRightPanel,
  rightPanelHostRef,
  selectThreadRightPanelState,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import {
  chatFileTarget,
  hostShownChat,
  type OpenOrigin,
  openLinkedFolder,
  sideChatOrigin,
} from "./chatFileOpener";
import {
  asPaneId,
  asSplitId,
  asTabId,
  type Edge,
  type LayoutNode,
  leaves,
  linkedFileTabId,
  PRIMARY_CHAT,
  resolveLayout,
  secondaryChatTabId,
  stripEntries,
  surfaceTabId,
  type TabId,
  type WorkAreaLayout,
  type WorkAreaTab,
} from "./workArea.logic";
import {
  drawWorkArea,
  isStripView,
  NO_VIEW,
  ratioBounds,
  shownSurfaces,
} from "./workAreaGeometry.logic";
import { armFocusedPane } from "./workAreaCommands";
import { openBesideTarget, repairWorkArea, type WorkAreaChange } from "./workAreaPlacement.logic";
import { mergePersistedWorkArea, persistedRecord, restoreWorkArea } from "./workAreaStorage.logic";
import { publishWorkAreaView, runWithOpenOrigin } from "./workAreaView";

const env = EnvironmentId.make("env-1");
const ref = scopeThreadRef(env, ThreadId.make("thread-primary"));
const other = scopeThreadRef(env, ThreadId.make("thread-other"));
const third = scopeThreadRef(env, ThreadId.make("thread-third"));
const WIDE = { narrow: false, size: { width: 1200, height: 800 } };

const projectRoots = vi.hoisted(() => new Map<string, string | null>());

vi.mock("../whiteboard/role", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../whiteboard/role")>()),
  boardOfferedFor: () => true,
  readThreadProjectRoot: (thread: ScopedThreadRef) => {
    const key = scopedThreadKey(thread);
    return projectRoots.has(key) ? projectRoots.get(key)! : "/project";
  },
}));

beforeEach(() => {
  projectRoots.clear();
  publishWorkAreaView(NO_VIEW);
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

const store = () => useRightPanelStore.getState();
const record = () => selectThreadRightPanelState(store().byThreadKey, ref);
const layout = () => resolveLayout(record());
const panes = () => leaves(layout().root);
const paneAt = (index: number) => panes()[index]!;

type Shape =
  | readonly string[]
  | { readonly axis: string; readonly first: Shape; readonly second: Shape };
function shapeOf(node: LayoutNode): Shape {
  return node.kind === "pane"
    ? node.tabs
    : { axis: node.axis, first: shapeOf(node.first), second: shapeOf(node.second) };
}
const shape = () => shapeOf(layout().root);
const actives = () => panes().map((pane) => pane.active);
const focusedIndex = () => panes().findIndex((pane) => pane.id === layout().focused);
const change = (next: WorkAreaChange) => store().updateWorkArea(ref, next);
const tab = surfaceTabId;
const chatEntries = () =>
  stripEntries(
    layout(),
    record(),
    panes().flatMap((pane) => pane.tabs),
    ref,
    "Chat",
  ).flatMap((entry) =>
    entry.kind === "chat" ? [{ closable: entry.closable, thread: entry.thread ?? null }] : [],
  );

/** One pane: [chat, ...files], the last file active. */
function onePane(...files: string[]) {
  const narrow = publishWorkAreaView({ narrow: true, size: null });
  for (const file of files) store().openFile(ref, file);
  narrow();
}

/** Two panes: [chat] | [...files], the right pane focused. */
function chatBeside(...files: string[]) {
  for (const file of files) store().openFile(ref, file);
}

describe("work area tree", () => {
  it.each<[Edge, Shape]>([
    ["left", { axis: "row", first: ["file:a.ts"], second: ["chat"] }],
    ["right", { axis: "row", first: ["chat"], second: ["file:a.ts"] }],
    ["top", { axis: "column", first: ["file:a.ts"], second: ["chat"] }],
    ["bottom", { axis: "column", first: ["chat"], second: ["file:a.ts"] }],
  ])("splits a pane on its %s edge with the dropped tab in the new pane", (edge, expected) => {
    onePane("a.ts");
    change({
      type: "place",
      source: { tabs: [tab("file:a.ts")] },
      at: { kind: "edge", pane: paneAt(0).id, edge },
    });
    expect(shape()).toEqual(expected);
    expect(panes()[focusedIndex()]!.tabs).toEqual(["file:a.ts"]);
  });

  it("nests splits and moves a tab across an ancestor, collapsing the pane it left", () => {
    chatBeside("a.ts", "b.ts");
    change({
      type: "place",
      source: { tabs: [tab("file:b.ts")] },
      at: { kind: "edge", pane: paneAt(1).id, edge: "bottom" },
    });
    expect(shape()).toEqual({
      axis: "row",
      first: ["chat"],
      second: { axis: "column", first: ["file:a.ts"], second: ["file:b.ts"] },
    });
    change({
      type: "place",
      source: { tabs: [tab("file:b.ts")] },
      at: { kind: "edge", pane: paneAt(0).id, edge: "left" },
    });
    expect(shape()).toEqual({
      axis: "row",
      first: { axis: "row", first: ["file:b.ts"], second: ["chat"] },
      second: ["file:a.ts"],
    });
  });

  it("refuses a lone tab dropped on its own pane's edge", () => {
    chatBeside("a.ts");
    const before = layout();
    change({
      type: "place",
      source: { tabs: [tab("file:a.ts")] },
      at: { kind: "edge", pane: paneAt(1).id, edge: "bottom" },
    });
    expect(layout()).toBe(before);
  });

  it("restores the source pane's pre-press tab after a drag", () => {
    chatBeside("a.ts", "b.ts");
    store().activateSurface(ref, "file:a.ts");
    change({
      type: "place",
      source: { tabs: [tab("file:a.ts")] },
      at: { kind: "join", pane: paneAt(0).id },
      restore: tab("file:b.ts"),
    });
    expect(shape()).toEqual({ axis: "row", first: ["chat", "file:a.ts"], second: ["file:b.ts"] });
    expect(actives()).toEqual(["file:a.ts", "file:b.ts"]);
  });

  it("closes a pane with its last tab and keeps no record for the default layout", () => {
    chatBeside("a.ts");
    store().closeSurface(ref, "file:a.ts");
    expect(shape()).toEqual(["chat"]);
    expect(scopedThreadKey(ref) in store().byThreadKey).toBe(false);
  });

  it("keeps one Chat per thread, refuses to close the last Chat and closes any other", () => {
    expect(chatEntries()).toEqual([{ closable: false, thread: null }]);
    change({
      type: "place",
      source: { threads: [other] },
      at: { kind: "join", pane: paneAt(0).id },
    });
    change({
      type: "place",
      source: { threads: [other] },
      at: { kind: "edge", pane: paneAt(0).id, edge: "right" },
    });
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: [secondaryChatTabId(other)] });
    expect(chatEntries()).toEqual([
      { closable: true, thread: ref },
      { closable: true, thread: other },
    ]);
    change({ type: "close", tab: PRIMARY_CHAT });
    expect(shape()).toEqual([secondaryChatTabId(other)]);
    expect(chatEntries()).toEqual([{ closable: false, thread: other }]);
    change({ type: "close", tab: secondaryChatTabId(other) });
    expect(shape()).toEqual([secondaryChatTabId(other)]);
  });

  it("keeps a Chat-only layout through the store's write path", () => {
    change({
      type: "place",
      source: { threads: [other, third] },
      at: { kind: "join", pane: paneAt(0).id },
    });
    store().openFile(ref, "a.ts");
    store().closeSurface(ref, "file:a.ts");
    expect(record().surfaces).toEqual([]);
    expect(scopedThreadKey(ref) in store().byThreadKey).toBe(true);
    expect(shape()).toEqual(["chat", secondaryChatTabId(other), secondaryChatTabId(third)]);
  });

  it("inserts a strip drop in the pane that holds the tab under the marker", () => {
    chatBeside("a.ts");
    change({
      type: "place",
      source: { threads: [other] },
      at: { kind: "strip", pane: paneAt(1).id, before: PRIMARY_CHAT },
    });
    expect(shape()).toEqual({
      axis: "row",
      first: [secondaryChatTabId(other), "chat"],
      second: ["file:a.ts"],
    });
    expect(focusedIndex()).toBe(0);
  });

  it("keeps every pane at its minimum when a divider is dragged to its bound", () => {
    chatBeside("a.ts", "b.ts");
    change({
      type: "place",
      source: { tabs: [tab("file:b.ts")] },
      at: { kind: "edge", pane: paneAt(1).id, edge: "right" },
    });
    const dividers = () => drawWorkArea(layout(), WIDE).dividers;
    change({ type: "ratio", split: dividers()[1]!.split.id, ratio: 0.6 });
    const outer = dividers()[0]!;
    change({ type: "ratio", split: outer.split.id, ratio: ratioBounds(outer, WIDE.size).max });
    expect(isStripView(layout(), WIDE)).toBe(false);
  });
});

describe("where shown tabs go", () => {
  it("splits beside a shown Chat for a user open and joins the focused non-Chat pane next", () => {
    store().openFile(ref, "a.ts");
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["file:a.ts"] });
    expect(focusedIndex()).toBe(1);
    store().openFile(ref, "b.ts");
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["file:a.ts", "file:b.ts"] });
    expect(record().activeSurfaceId).toBe("file:b.ts");
  });

  it("activates a pressed tab where it is, even over a Chat, and focuses its pane", () => {
    onePane("a.ts");
    change({ type: "activate", tab: PRIMARY_CHAT });
    chatBeside("b.ts");
    expect(shape()).toEqual({ axis: "row", first: ["chat", "file:a.ts"], second: ["file:b.ts"] });
    store().activateSurface(ref, "file:a.ts");
    expect(actives()).toEqual(["file:a.ts", "file:b.ts"]);
    expect(focusedIndex()).toBe(0);
  });

  it("moves an automatic reveal off a shown Chat without moving the focus", () => {
    const narrow = publishWorkAreaView({ narrow: true, size: null });
    store().openBrowser(ref, "t1");
    narrow();
    change({ type: "activate", tab: PRIMARY_CHAT });
    chatBeside("b.ts");
    store().openBrowser(ref, "t1", true);
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["file:b.ts", "browser:t1"] });
    expect(actives()).toEqual(["chat", "browser:t1"]);
    expect(focusedIndex()).toBe(1);
  });

  it.each<[string, () => void, () => void, Shape, readonly string[]]>([
    [
      "puts a folder's new tab in the slot of the lone Files tab it replaces",
      () => store().open(ref, "files"),
      () => store().navigateFolder(ref, "files", "src/a.ts", "src"),
      { axis: "row", first: ["chat"], second: ["file:src/a.ts"] },
      ["chat", "file:src/a.ts"],
    ],
    [
      "puts a device in the slot of its placeholder",
      () => {
        chatBeside("a.ts");
        store().open(ref, "device");
        store().activateSurface(ref, "file:a.ts");
      },
      () => store().openDevice(ref, { hostId: "h", deviceId: "d", platform: "ios", name: "Phone" }),
      { axis: "row", first: ["chat"], second: ["file:a.ts", "device:h:d"] },
      ["chat", "device:h:d"],
    ],
    [
      "puts an agent's browser in the slot of the shown new-browser placeholder",
      () => {
        chatBeside("a.ts");
        store().open(ref, "preview");
      },
      () => store().openBrowser(ref, "t1", true),
      { axis: "row", first: ["chat"], second: ["file:a.ts", "browser:t1"] },
      ["chat", "browser:t1"],
    ],
    [
      "shows an open file clicked in the shown explorer",
      () => {
        chatBeside("a.ts", "b.ts");
        store().open(ref, "files");
      },
      () => store().openFile(ref, "a.ts"),
      { axis: "row", first: ["chat"], second: ["file:a.ts", "file:b.ts"] },
      ["chat", "file:a.ts"],
    ],
    [
      "adds a refreshed browser session in the background when the shown one goes",
      () => {
        store().reconcileBrowserSurfaces(ref, ["t1"]);
        store().activateSurface(ref, "browser:t1");
      },
      () => store().reconcileBrowserSurfaces(ref, ["t2"]),
      ["chat", "browser:t2"],
      ["chat"],
    ],
    [
      "splits beside the shown Chat for a file that replaces an explorer hidden behind it",
      () => {
        const narrow = publishWorkAreaView({ narrow: true, size: null });
        store().open(ref, "files");
        narrow();
        change({ type: "activate", tab: PRIMARY_CHAT });
      },
      () => store().openFile(ref, "x.ts"),
      { axis: "row", first: ["chat"], second: ["file:x.ts"] },
      ["chat", "file:x.ts"],
    ],
  ])("%s", (_name, arrange, act, expectedShape, expectedActives) => {
    arrange();
    act();
    expect(shape()).toEqual(expectedShape);
    expect(actives()).toEqual(expectedActives);
  });

  it("adds a background browser beside the Chat and treats a removal fallback as maintenance", () => {
    onePane("a.ts");
    change({ type: "activate", tab: PRIMARY_CHAT });
    chatBeside("b.ts");
    store().reconcileBrowserSurfaces(ref, ["t1"]);
    expect(shape()).toEqual({
      axis: "row",
      first: ["chat", "file:a.ts"],
      second: ["file:b.ts", "browser:t1"],
    });
    expect(actives()).toEqual(["chat", "file:b.ts"]);
    store().activateSurface(ref, "browser:t1");
    store().reconcileBrowserSurfaces(ref, []);
    expect(actives()).toEqual(["chat", "file:b.ts"]);
    expect(focusedIndex()).toBe(1);
  });

  it("splits for an automatic open only when the split fits, and never moves the focus", () => {
    const narrowPane = publishWorkAreaView({ narrow: false, size: { width: 400, height: 800 } });
    store().open(ref, "diff", true);
    expect(shape()).toEqual(["chat", "diff"]);
    expect(actives()).toEqual(["chat"]);
    expect(record().activeSurfaceId).toBeNull();
    narrowPane();
    store().closeSurface(ref, "diff");
    publishWorkAreaView(WIDE);
    store().open(ref, "diff", true);
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["diff"] });
    expect(focusedIndex()).toBe(0);
    expect(record().activeSurfaceId).toBeNull();
  });

  it("keeps an automatic open off the shown Chat when no work area is mounted", () => {
    store().open(ref, "diff", true);
    expect(shape()).toEqual(["chat", "diff"]);
    expect(actives()).toEqual(["chat"]);
  });

  it("arms a pane by kind for the next open of that kind and for background adds", () => {
    chatBeside("a.ts");
    change({ type: "arm", pane: paneAt(0).id, kind: "preview" });
    store().reconcileBrowserSurfaces(ref, ["t1"]);
    expect(shape()).toEqual({ axis: "row", first: ["chat", "browser:t1"], second: ["file:a.ts"] });
    expect(layout().armed?.kind).toBe("preview");
    store().openBrowser(ref, "t2", true);
    expect(paneAt(1).tabs).toContain("browser:t2");
    expect(layout().armed?.kind).toBe("preview");
    change({ type: "arm", pane: paneAt(0).id, kind: "diff" });
    store().open(ref, "diff");
    expect(paneAt(0).tabs).toContain("diff");
    expect(actives()[0]).toBe("diff");
    expect(layout().armed).toBeUndefined();
    change({ type: "arm", pane: paneAt(0).id, kind: "files" });
    change({ type: "focus", pane: paneAt(1).id });
    expect(layout().armed).toBeUndefined();
  });

  it.each([
    ["before", () => {}],
    ["after", () => store().reconcileBrowserSurfaces(ref, ["t1"])],
  ])(
    "opens a browser over a new thread's Chat after arming its focused pane, %s its session is listed",
    (_, listSession) => {
      publishWorkAreaView(WIDE);
      armFocusedPane(ref, "preview");
      listSession();
      store().openBrowser(ref, "t1");
      expect(shape()).toEqual(["chat", "browser:t1"]);
      expect(shownSurfaces(record(), WIDE).map((surface) => surface.id)).toEqual(["browser:t1"]);
      expect(layout().armed).toBeUndefined();
    },
  );
});

type Grid = string | readonly ["row" | "column", Grid, Grid, number?];

/** One tab per pane, named by the pane; a name starting with "Chat" is a Chat tab. */
function gridLayout(grid: Grid): WorkAreaLayout {
  const tabs: Record<TabId, WorkAreaTab> = {};
  let splits = 0;
  const build = (node: Grid): LayoutNode => {
    if (typeof node === "string") {
      const id = asTabId(node);
      tabs[id] = node.startsWith("Chat")
        ? { kind: "secondary-chat", thread: other, placement: 0 }
        : { kind: "surface" };
      return { kind: "pane", id: asPaneId(node), tabs: [id], active: id };
    }
    const [axis, first, second, ratio = 0.5] = node;
    splits += 1;
    return {
      kind: "split",
      id: asSplitId(`s${splits}`),
      axis,
      ratio,
      first: build(first),
      second: build(second),
    };
  };
  const root = build(grid);
  return { root, tabs, focused: leaves(root)[0]!.id, seq: 0 };
}

const fromChat = (act: () => void) => runWithOpenOrigin({ record: ref, tab: PRIMARY_CHAT }, act);

describe("opens that start in a chat", () => {
  const THIRDS: Grid = ["row", "Chat1", ["row", "Chat2", "Files"], 1 / 3];
  const STACK: Grid = ["column", "Chat", "WB"];
  const CHATS_LEFT: Grid = ["row", ["column", "Chat1", "Chat2"], "Files"];
  const TOOLS_RIGHT: Grid = ["row", "Chat", ["column", "WB", "Files"]];
  it.each<[string, string, string, Grid]>([
    ["[Chat1 | Chat2 | Files]", "Chat1", "Files", THIRDS],
    ["[Chat1 | Chat2 | Files]", "Chat2", "Files", THIRDS],
    ["[Chat1 | Chat2 | Files]", "Files", "Chat2", THIRDS],
    ["[Chat | WB | Files]", "Chat", "WB", ["row", "Chat", ["row", "WB", "Files"], 1 / 3]],
    ["[Chat / WB]", "Chat", "WB", STACK],
    ["[Chat / WB]", "WB", "Chat", STACK],
    ["[(Chat1 / Chat2) | Files]", "Chat1", "Files", CHATS_LEFT],
    ["[(Chat1 / Chat2) | Files]", "Chat2", "Files", CHATS_LEFT],
    ["[(Chat1 / Chat2) | Files]", "Files", "Chat1", CHATS_LEFT],
    ["[Chat | (WB / Files)]", "Chat", "WB", TOOLS_RIGHT],
    ["[Chat | (WB / Files)]", "WB", "Files", TOOLS_RIGHT],
    ["[Chat | (WB / Files)]", "Files", "WB", TOOLS_RIGHT],
    ["[WB | (Chat / Files)]", "Chat", "WB", ["row", "WB", ["column", "Chat", "Files"]]],
    [
      "[(A / ChatC) | (B / D)]",
      "ChatC",
      "D",
      ["row", ["column", "A", "ChatC"], ["column", "B", "D"]],
    ],
    ["[(A | B) / ChatC]", "ChatC", "A", ["column", ["row", "A", "B"], "ChatC"]],
    [
      "[(Chat1 / Chat2) | (A / B / Chat3)], no shared edge",
      "Chat2",
      "A",
      [
        "row",
        ["column", "Chat1", "Chat2", 0.75],
        ["column", "A", ["column", "B", "Chat3", 1 / 3], 0.25],
      ],
    ],
  ])("%s: from %s opens in %s", (_name, from, expected, grid) => {
    expect(openBesideTarget(gridLayout(grid), asPaneId(from))).toBe(asPaneId(expected));
  });

  it.each<[string, () => void, Shape, number]>([
    [
      "sourceless, into the focused pane",
      () => store().openFile(ref, "b.ts"),
      ["chat", "file:a.ts", "file:b.ts"],
      0,
    ],
    [
      "from the Chat, splitting the one pane",
      () => fromChat(() => store().openFile(ref, "b.ts")),
      { axis: "row", first: ["chat", "file:a.ts"], second: ["file:b.ts"] },
      1,
    ],
    [
      "from a Chat no pane holds, as sourceless",
      () =>
        runWithOpenOrigin({ record: ref, tab: secondaryChatTabId(third) }, () =>
          store().openFile(ref, "b.ts"),
        ),
      ["chat", "file:a.ts", "file:b.ts"],
      0,
    ],
    [
      "from a Chat of another record, as sourceless",
      () =>
        runWithOpenOrigin({ record: other, tab: PRIMARY_CHAT }, () =>
          store().openFile(ref, "b.ts"),
        ),
      ["chat", "file:a.ts", "file:b.ts"],
      0,
    ],
  ])("opens a file in one pane showing a file %s", (_name, act, expectedShape, focused) => {
    onePane("a.ts");
    act();
    expect(shape()).toEqual(expectedShape);
    expect(focusedIndex()).toBe(focused);
    expect(record().activeSurfaceId).toBe("file:b.ts");
  });

  it.each<[string, () => void, Shape, number]>([
    [
      "splits the Chat's one pane when no work area is mounted",
      () => {},
      { axis: "row", first: ["chat"], second: ["file:a.ts"] },
      1,
    ],
    [
      "splits the Chat's one pane when the split fits",
      () => publishWorkAreaView(WIDE),
      { axis: "row", first: ["chat"], second: ["file:a.ts"] },
      1,
    ],
    [
      "opens in the Chat's one pane in a narrow view",
      () => publishWorkAreaView({ narrow: true, size: null }),
      ["chat", "file:a.ts"],
      0,
    ],
  ])("%s", (_name, arrange, expectedShape, focused) => {
    arrange();
    fromChat(() => store().openFile(ref, "a.ts"));
    expect(shape()).toEqual(expectedShape);
    expect(actives().at(-1)).toBe("file:a.ts");
    expect(focusedIndex()).toBe(focused);
  });

  it("drops the explorer in another pane and opens beside the Chat, not in the explorer's slot", () => {
    chatBeside("a.ts");
    store().open(ref, "files");
    change({
      type: "place",
      source: { tabs: [tab("files")] },
      at: { kind: "edge", pane: paneAt(1).id, edge: "right" },
    });
    fromChat(() => store().openFile(ref, "x.ts"));
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["file:a.ts", "file:x.ts"] });
    expect(actives()).toEqual(["chat", "file:x.ts"]);
    expect(focusedIndex()).toBe(1);
  });

  it("shows a file already open in another pane there, without a second tab", () => {
    chatBeside("a.ts", "b.ts");
    change({ type: "focus", pane: paneAt(0).id });
    fromChat(() => store().openFile(ref, "a.ts"));
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["file:a.ts", "file:b.ts"] });
    expect(actives()).toEqual(["chat", "file:a.ts"]);
    expect(focusedIndex()).toBe(1);
  });

  it("opens a link in a linked file beside that file, as sourceless once the file is closed", () => {
    change({ type: "link-file", source: other, path: "src/x.ts", line: null });
    const linked = linkedFileTabId(other, "src/x.ts");
    const target = chatFileTarget({ kind: "shown", owner: ref, tab: linked }, other);
    target.openFile("src/y.ts");
    expect(shape()).toEqual({
      axis: "row",
      first: ["chat", linkedFileTabId(other, "src/y.ts")],
      second: [linked],
    });
    expect(focusedIndex()).toBe(0);
    change({ type: "close", tab: linked });
    target.openFile("src/z.ts");
    expect(shape()).toEqual([
      "chat",
      linkedFileTabId(other, "src/y.ts"),
      linkedFileTabId(other, "src/z.ts"),
    ]);
  });

  it("moves the owner's explorer to a linked file's folder crumb, beside the linked file", () => {
    change({ type: "link-file", source: other, path: "src/x.ts", line: null });
    const linked = linkedFileTabId(other, "src/x.ts");
    openLinkedFolder(ref, linked, "src", "src/x.ts");
    expect(shape()).toEqual({ axis: "row", first: ["chat", "file:src"], second: [linked] });
    expect(record().surfaces.find((surface) => surface.id === "file:src")).toMatchObject({
      folderTrail: "src/x.ts",
    });
    expect(focusedIndex()).toBe(0);
  });

  it("keeps a secondary Chat's click-time source when another pane is pressed before the open", () => {
    change({
      type: "place",
      source: { threads: [other] },
      at: { kind: "edge", pane: paneAt(0).id, edge: "right" },
    });
    const chat = secondaryChatTabId(other);
    const payload = layout().tabs[chat];
    const target = chatFileTarget(
      {
        kind: "shown",
        owner: ref,
        tab: chat,
        placement: payload?.kind === "secondary-chat" ? payload.placement : -1,
      },
      other,
    );
    change({ type: "focus", pane: paneAt(0).id });
    target.openFile("src/x.ts");
    expect(shape()).toEqual({
      axis: "row",
      first: ["chat", linkedFileTabId(other, "src/x.ts")],
      second: [chat],
    });
    expect(focusedIndex()).toBe(0);
  });
});

describe("a chat opener's origin", () => {
  const side = scopeThreadRef(env, ThreadId.make("thread-side"));
  const attachment = {
    type: "file",
    id: "att-1",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 1,
  } as const;
  const opens = {
    "a file": (target: ReturnType<typeof chatFileTarget>) => target.openFile("b.ts"),
    "an attachment": (target: ReturnType<typeof chatFileTarget>) =>
      target.openAttachment(attachment),
    "a board link": (target: ReturnType<typeof chatFileTarget>) =>
      target.openBoardRef("board://r/1,2,3,4"),
  };

  /** Arranges the owner's layout; returns the origin and the thread the chat shows. */
  const fixtures: Record<string, () => [OpenOrigin | null, ScopedThreadRef]> = {
    "markdown with no chat around it, as sourceless": () => {
      onePane("a.ts");
      return [null, ref];
    },
    "the primary Chat": () => {
      onePane("a.ts");
      return [{ kind: "own", tab: PRIMARY_CHAT }, ref];
    },
    "a hosted side chat": () => {
      store().openSideChat(ref, side.threadId);
      return [sideChatOrigin(side.threadId), side];
    },
    "a secondary Chat": () => {
      change({
        type: "place",
        source: { threads: [other] },
        at: { kind: "edge", pane: paneAt(0).id, edge: "right" },
      });
      const tab = secondaryChatTabId(other);
      const payload = layout().tabs[tab];
      const placement = payload?.kind === "secondary-chat" ? payload.placement : -1;
      return [{ kind: "shown", owner: ref, tab, placement }, other];
    },
  };
  const expected: Record<keyof typeof fixtures, [pane: number, panes: number]> = {
    "markdown with no chat around it, as sourceless": [0, 1],
    "the primary Chat": [1, 2],
    "a hosted side chat": [0, 2],
    "a secondary Chat": [0, 2],
  };
  const allTabs = () => new Set(panes().flatMap((pane) => pane.tabs));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(
    Object.keys(fixtures).flatMap((name) =>
      (Object.keys(opens) as (keyof typeof opens)[]).map((open) => [name, open] as const),
    ),
  )("from %s, places %s", (name, open) => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", new EventTarget());
    const unhost = hostRightPanel(side, ref);
    try {
      const [origin, thread] = fixtures[name]!();
      const before = allTabs();
      opens[open](chatFileTarget(origin, thread));
      const added = [...allTabs()].filter((tab) => !before.has(tab));
      expect(added).toHaveLength(1);
      const pane = panes().findIndex((candidate) => candidate.tabs.includes(added[0]!));
      expect([pane, panes().length]).toEqual(expected[name]);
    } finally {
      unhost();
    }
  });

  const far = scopeThreadRef(EnvironmentId.make("env-2"), ThreadId.make("thread-far"));
  it.each<[string, ScopedThreadRef, Record<string, string | null>, boolean]>([
    ["the same environment and root", other, {}, true],
    ["another environment", far, {}, false],
    ["another root", other, { [scopedThreadKey(other)]: "/elsewhere" }, false],
    ["a null root", other, { [scopedThreadKey(ref)]: null, [scopedThreadKey(other)]: null }, false],
  ])("shows a mounted secondary Chat's board link from %s", (_name, guest, roots, shown) => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", new EventTarget());
    for (const [key, root] of Object.entries(roots)) projectRoots.set(key, root);
    using _mounted = { [Symbol.dispose]: hostShownChat(guest, ref) ?? (() => {}) };
    chatFileTarget(
      { kind: "shown", owner: ref, tab: secondaryChatTabId(guest) },
      guest,
    ).openBoardRef("board://r/1,2,3,4");
    const listsBoard = (thread: ScopedThreadRef) =>
      selectThreadRightPanelState(store().byThreadKey, thread).surfaces.some(
        (surface) => surface.kind === "whiteboard",
      );
    expect({ owner: listsBoard(ref), guest: listsBoard(guest) }).toEqual({
      owner: shown,
      guest: false,
    });
  });

  it.each([
    ["the owner's environment", other, ref],
    ["another environment", far, far],
  ])("routes a shown secondary Chat's panel actions from %s", (_name, guest, host) => {
    using _mounted = { [Symbol.dispose]: hostShownChat(guest, ref) ?? (() => {}) };
    expect(rightPanelHostRef(guest)).toEqual(host);
  });
});

describe("work area records", () => {
  it("mirrors a null active surface while a Chat is focused and saves a real tab", async () => {
    chatBeside("a.ts");
    change({ type: "focus", pane: paneAt(0).id });
    expect(record().activeSurfaceId).toBeNull();
    expect(record().isOpen).toBe(true);
    expect(persistedRecord(record()).activeSurfaceId).toBe("file:a.ts");

    const { storage, name } = useRightPanelStore.persist.getOptions();
    const saved = (await storage!.getItem(name!))!;
    useRightPanelStore.setState(useRightPanelStore.getInitialState());
    await storage!.setItem(name!, saved);
    await useRightPanelStore.persist.rehydrate();
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["file:a.ts"] });
    expect(record().activeSurfaceId).toBeNull();
  });

  it.each<[string, boolean, Shape, readonly string[], string | null]>([
    [
      "an open panel",
      true,
      { axis: "row", first: ["chat"], second: ["file:a", "file:b"] },
      ["chat", "file:b"],
      "file:b",
    ],
    ["a closed panel", false, ["chat", "file:a", "file:b"], ["chat"], null],
  ])(
    "seeds a layout from an older build's record with %s",
    (_name, isOpen, expected, active, mirror) => {
      const older: ThreadRightPanelState = {
        isOpen,
        activeSurfaceId: "file:b",
        surfaces: [
          { id: "file:a", kind: "file", relativePath: "a", revealLine: null, revealRequestId: 1 },
          { id: "file:b", kind: "file", relativePath: "b", revealLine: null, revealRequestId: 1 },
        ],
      };
      const merged = mergePersistedWorkArea(
        { byThreadKey: { [scopedThreadKey(ref)]: older } },
        useRightPanelStore.getInitialState(),
      );
      useRightPanelStore.setState({ byThreadKey: merged.byThreadKey });
      expect(shape()).toEqual(expected);
      expect(actives()).toEqual(active);
      expect(record().activeSurfaceId).toBe(mirror);
    },
  );

  it.each<[string, unknown]>([
    ["an empty pane", { kind: "pane", id: "pane-x", tabs: [] }],
    [
      "two splits with one id",
      {
        kind: "split",
        id: "s1",
        axis: "row",
        ratio: 0.5,
        first: {
          kind: "split",
          id: "s1",
          axis: "column",
          ratio: 0.5,
          first: { kind: "pane", id: "p0", tabs: ["chat"], active: "chat" },
          second: { kind: "pane", id: "p1", tabs: ["diff"], active: "diff" },
        },
        second: { kind: "pane", id: "p2", tabs: ["files"], active: "files" },
      },
    ],
  ])("drops a stored layout with %s and places the record's tabs in the default one", (_, root) => {
    const merged = mergePersistedWorkArea(
      {
        byThreadKey: {
          [scopedThreadKey(ref)]: {
            isOpen: true,
            activeSurfaceId: "diff",
            surfaces: [
              { id: "diff", kind: "diff" },
              { id: "files", kind: "files" },
            ],
            workArea: { root, tabs: {}, focused: "p0", seq: 3 },
          },
        },
      },
      useRightPanelStore.getInitialState(),
    );
    useRightPanelStore.setState({ byThreadKey: merged.byThreadKey });
    expect(shape()).toEqual(["chat", "diff", "files"]);
  });

  it("repairs a damaged layout once and returns a settled one unchanged", () => {
    const damaged = restoreWorkArea({
      root: {
        kind: "split",
        id: "s1",
        axis: "row",
        ratio: 3,
        first: { kind: "pane", id: "p0", tabs: ["file:gone", "diff"], active: "file:gone" },
        second: { kind: "pane", id: "p1", tabs: ["diff", "files"], active: "diff" },
      },
      tabs: {},
      focused: "p1",
      seq: 0,
    });
    expect(damaged).not.toBeNull();
    const surfaces = [
      { id: "diff" as const, kind: "diff" as const },
      { id: "files" as const, kind: "files" as const },
    ];
    const repaired = repairWorkArea(damaged!, surfaces);
    expect(shapeOf(repaired.root)).toEqual({
      axis: "row",
      first: ["diff"],
      second: ["files", "chat"],
    });
    expect(repaired.root.kind === "split" ? repaired.root.ratio : null).toBe(0.85);
    expect(repaired.seq).toBe(2);
    expect(repairWorkArea(repaired, surfaces)).toBe(repaired);
  });

  it("upserts one linked tab per thread and path or attachment, and drops a link from a Chat placed again", () => {
    const chat = secondaryChatTabId(other);
    const addOther = () =>
      change({
        type: "place",
        source: { threads: [other] },
        at: { kind: "join", pane: paneAt(0).id },
      });
    const placed = () => {
      const payload = layout().tabs[chat];
      return { tab: chat, placement: payload?.kind === "secondary-chat" ? payload.placement : -1 };
    };
    const linked = () =>
      Object.values(layout().tabs).filter((payload) => payload.kind === "linked-file");
    addOther();
    const from = placed();
    const entryOf = (tab: TabId) => stripEntries(layout(), record(), [tab], ref, "Chat")[0];
    const fileTab = linkedFileTabId(other, "src/x.ts");
    change({ type: "link-file", source: other, path: "src/x.ts", line: 3, from });
    const firstEntry = entryOf(fileTab);
    expect(entryOf(fileTab)).toBe(firstEntry);
    change({ type: "link-file", source: other, path: "src/x.ts/", line: 9, from });
    expect(linked()).toEqual([expect.objectContaining({ path: "src/x.ts", line: 9, reveal: 2 })]);
    expect(entryOf(fileTab)).not.toBe(firstEntry);
    expect(entryOf(fileTab)).toMatchObject({ revealLine: 9, revealRequestId: 2, source: other });

    const attachment = {
      type: "file" as const,
      id: "notes-1",
      name: "src/x.ts",
      mimeType: "text/plain",
      sizeBytes: 12,
    };
    const attachmentTab = linkedFileTabId(other, "src/x.ts", attachment.id);
    change({ type: "link-file", source: other, path: "src/x.ts", line: null, attachment, from });
    change({ type: "link-file", source: other, path: "src/x.ts", line: null, attachment, from });
    expect(layout().tabs[attachmentTab]).toMatchObject({ attachment, reveal: 2 });
    expect(entryOf(attachmentTab)).toMatchObject({ attachment, relativePath: "src/x.ts" });
    expect(linked()).toHaveLength(2);
    expect(restoreWorkArea(JSON.parse(JSON.stringify(layout())))?.tabs).toEqual(layout().tabs);

    change({ type: "close", tab: attachmentTab });
    change({ type: "close", tab: fileTab });
    change({ type: "close", tab: chat });
    addOther();
    change({ type: "link-file", source: other, path: "src/y.ts", line: null, from });
    expect(linked()).toEqual([]);
  });

  it("lists the active surface of every drawn pane, or of the one strip when narrow", () => {
    onePane("a.ts");
    change({ type: "activate", tab: PRIMARY_CHAT });
    chatBeside("b.ts");
    store().activateSurface(ref, "file:a.ts");
    expect(shownSurfaces(record(), WIDE).map((surface) => surface.id)).toEqual([
      "file:a.ts",
      "file:b.ts",
    ]);
    const narrow = { narrow: true, size: null };
    expect(shownSurfaces(record(), narrow).map((surface) => surface.id)).toEqual(["file:a.ts"]);
    expect(drawWorkArea(layout(), narrow).panes[0]!.tabs).toEqual([
      "chat",
      "file:a.ts",
      "file:b.ts",
    ]);
    expect(leaves(layout().root)).toHaveLength(2);
  });
});
