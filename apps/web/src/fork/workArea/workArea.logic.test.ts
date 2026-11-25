import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as browserDefaults from "~/browser/browserDefaults";
import { openFileInPreview, openUrlInPreview } from "~/browser/openFileInPreview";
import * as previewRuntime from "~/browser/previewRuntime";
import { addBrowserSurface } from "~/components/preview/addBrowserSurface";
import { toastManager } from "~/components/ui/toast";
import { WORK_AREA_COPY } from "~/fork/forkCopy";
import { hostRightPanel, rightPanelHostRef, selectThreadRightPanelState } from "~/rightPanelStore";
import * as sessionState from "~/state/session";

import {
  chatFileTarget,
  hostShownChat,
  type OpenOrigin,
  openLinkedFolder,
  sideThreadEmbedding,
} from "./chatFileOpener";
import { openThreadTab } from "./chatOpenerContext";
import {
  asPaneId,
  asSplitId,
  asTabId,
  type Edge,
  type LayoutNode,
  leaves,
  linkedFileTabId,
  holders,
  openInFileTab,
  PRIMARY_CHAT,
  replyTabId,
  secondaryChatTabId,
  stripEntries,
  type TabId,
  type WorkAreaLayout,
  type WorkAreaTab,
} from "./workArea.logic";
import {
  drawWorkArea,
  isStripView,
  ratioBounds,
  shownSurfaces,
  type WorkAreaView,
} from "./workAreaGeometry.logic";
import { armFocusedPane, toggleDiff, togglePreview } from "./workAreaCommands";
import {
  applyWorkAreaChange,
  landingRect,
  moveToward,
  openBesideTarget,
  type WorkAreaChange,
} from "./workAreaPlacement.logic";
import {
  actives,
  change,
  chatAndFile,
  chatBeside,
  env,
  focusedIndex,
  fromChat,
  holderOf,
  layout,
  onePane,
  other,
  paneAt,
  panes,
  record,
  ref,
  resetWorkAreaStore,
  type Shape,
  shape,
  store,
  tab,
  third,
  viewOf,
  WIDE,
  wide,
} from "./workAreaTestKit";
import { publishWorkAreaView, runWithOpenOrigin } from "./workAreaView";

const projectRoots = vi.hoisted(() => new Map<string, string | null>());
const session = vi.hoisted(() => ({ open: (_tabId: string) => {} }));

vi.mock("~/components/preview/openPreviewSession", () => ({
  openPreviewSession: () =>
    new Promise((resolve) => {
      session.open = (tabId) => resolve({ _tag: "Success", value: { tabId } });
    }),
}));

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
  resetWorkAreaStore();
});

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
      source: { view: viewOf(tab("file:a.ts")) },
      at: { kind: "edge", pane: paneAt(0).id, edge },
    });
    expect(shape()).toEqual(expected);
    expect(panes()[focusedIndex()]!.tabs).toEqual(["file:a.ts"]);
  });

  it.each<[string, () => void, string, Edge, Shape | null, number]>([
    [
      "into the pane on its left, keeping the pane it left",
      () => chatBeside("a.ts", "b.ts"),
      "file:b.ts",
      "left",
      { axis: "row", first: ["chat", "file:b.ts"], second: ["file:a.ts"] },
      0,
    ],
    [
      "into the pane on its left, collapsing the pane it left with its last tab",
      () => chatBeside("a.ts"),
      "file:a.ts",
      "left",
      ["chat", "file:a.ts"],
      0,
    ],
    [
      "into the pane above",
      () => {
        chatBeside("a.ts", "b.ts");
        change({
          type: "place",
          source: { view: viewOf(tab("file:b.ts")) },
          at: { kind: "edge", pane: paneAt(1).id, edge: "bottom" },
        });
      },
      "file:b.ts",
      "top",
      { axis: "row", first: ["chat"], second: ["file:a.ts", "file:b.ts"] },
      1,
    ],
    ["nowhere when no pane lies that way", () => chatBeside("a.ts"), "file:a.ts", "right", null, 1],
  ])("moves a tab from its menu %s", (_name, arrange, moved, edge, expected, focused) => {
    arrange();
    const before = shape();
    const move = moveToward(layout(), viewOf(tab(moved)), edge);
    if (move) change(move);
    expect(shape()).toEqual(expected ?? before);
    expect(move === null).toBe(expected === null);
    expect(focusedIndex()).toBe(focused);
    expect(panes()[focused]!.active).toBe(moved);
  });

  it("nests splits and moves a tab across an ancestor, collapsing the pane it left", () => {
    chatBeside("a.ts", "b.ts");
    change({
      type: "place",
      source: { view: viewOf(tab("file:b.ts")) },
      at: { kind: "edge", pane: paneAt(1).id, edge: "bottom" },
    });
    expect(shape()).toEqual({
      axis: "row",
      first: ["chat"],
      second: { axis: "column", first: ["file:a.ts"], second: ["file:b.ts"] },
    });
    change({
      type: "place",
      source: { view: viewOf(tab("file:b.ts")) },
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
      source: { view: viewOf(tab("file:a.ts")) },
      at: { kind: "edge", pane: paneAt(1).id, edge: "bottom" },
    });
    expect(layout()).toBe(before);
  });

  it("restores the source pane's pre-press tab after a drag", () => {
    chatBeside("a.ts", "b.ts");
    store().activateSurface(ref, "file:a.ts");
    change({
      type: "place",
      source: { view: viewOf(tab("file:a.ts")), restore: tab("file:b.ts") },
      at: { kind: "join", pane: paneAt(0).id },
    });
    expect(shape()).toEqual({ axis: "row", first: ["chat", "file:a.ts"], second: ["file:b.ts"] });
    expect(actives()).toEqual(["file:a.ts", "file:b.ts"]);
  });

  it("shows the nearest remaining tab right of the active one when several close at once", () => {
    const narrow = publishWorkAreaView({ narrow: true, size: null });
    for (const id of ["t1", "t2", "t3", "t4", "t5"]) store().openBrowser(ref, id);
    store().activateSurface(ref, "browser:t3");
    store().reconcileBrowserSurfaces(ref, ["t1", "t4", "t5"]);
    narrow();
    expect(actives()).toEqual(["browser:t4"]);
  });

  it("shows the nearest remaining tab when the active one leaves for an edge", () => {
    const pane = asPaneId("p0");
    const [a, o, t, b, c] = ["file:a", "chat:o", "chat:t", "file:b", "file:c"].map(asTabId);
    const grid: WorkAreaLayout = {
      root: { kind: "pane", id: pane, tabs: [a!, o!, t!, b!, c!], active: t! },
      tabs: {
        [a!]: { kind: "surface" },
        [o!]: { kind: "secondary-chat", thread: other, placement: 0 },
        [t!]: { kind: "secondary-chat", thread: third, placement: 0 },
        [b!]: { kind: "surface" },
        [c!]: { kind: "surface" },
      },
      focused: pane,
      seq: 1,
    };
    const next = applyWorkAreaChange(
      grid,
      {
        type: "place",
        source: { view: { pane, tab: t! } },
        at: { kind: "edge", pane, edge: "right" },
      },
      ref,
      [],
      WIDE,
    );
    expect(holders(next.root, a!)[0]?.active).toBe(b);
  });

  it("closes a pane with its last tab and never reuses its id", () => {
    chatBeside("a.ts");
    const first = paneAt(1).id;
    store().closeSurface(ref, "file:a.ts");
    expect(shape()).toEqual(["chat"]);
    chatBeside("b.ts");
    expect(paneAt(1).id).not.toBe(first);
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
      source: { view: viewOf(secondaryChatTabId(other)) },
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
    chatFileTarget({ kind: "own", tab: secondaryChatTabId(other) }, ref).openSubThread("m-1");
    change({ type: "close", tab: replyTabId(ref, "m-1") });
    expect(shape()).toEqual([secondaryChatTabId(other)]);
  });

  it("keeps one tab per thread: a side-thread tab replaces a saved Chat tab of the thread", () => {
    const side = scopeThreadRef(env, ThreadId.make("side"));
    change({
      type: "place",
      source: { threads: [side] },
      at: { kind: "join", pane: paneAt(0).id },
    });
    expect(shape()).toEqual(["chat", secondaryChatTabId(side)]);
    store().openThread(ref, side.threadId);
    expect(panes().flatMap((pane) => pane.tabs)).toEqual(["chat", "thread:side"]);
    change({ type: "open-thread", thread: side });
    expect(actives()).toContain("thread:side");
    expect(layout().tabs[secondaryChatTabId(side)]).toBeUndefined();
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

  it("appends a sidebar selection joined to a pane that already holds one of its Chats", () => {
    change({
      type: "place",
      source: { threads: [other] },
      at: { kind: "strip", pane: paneAt(0).id, before: PRIMARY_CHAT },
    });
    expect(shape()).toEqual([secondaryChatTabId(other), "chat"]);
    change({
      type: "place",
      source: { threads: [other, third] },
      at: { kind: "join", pane: paneAt(0).id },
    });
    expect(shape()).toEqual(["chat", secondaryChatTabId(other), secondaryChatTabId(third)]);
  });

  it("keeps every pane at its minimum when a divider is dragged to its bound", () => {
    chatBeside("a.ts", "b.ts");
    change({
      type: "place",
      source: { view: viewOf(tab("file:b.ts")) },
      at: { kind: "edge", pane: paneAt(1).id, edge: "right" },
    });
    const dividers = () => drawWorkArea(layout(), WIDE).dividers;
    change({ type: "ratio", split: dividers()[1]!.split.id, ratio: 0.6 });
    const outer = dividers()[0]!;
    for (const bound of ["max", "min"] as const) {
      change({
        type: "ratio",
        split: outer.split.id,
        ratio: ratioBounds(layout(), outer, WIDE.size)[bound],
      });
      expect(isStripView(layout(), WIDE)).toBe(false);
    }
    const chatPane = drawWorkArea(layout(), WIDE).panes[0]!;
    expect(chatPane.rect.w * WIDE.size.width).toBeGreaterThanOrEqual(360 - 1e-6);
  });

  const chatFiles = (ratio: number) => gridLayout(["row", "Chat", "Files", ratio]);
  const firstDivider = (grid: WorkAreaLayout, width: number) =>
    drawWorkArea(grid, wide(width)).dividers[0]!;
  it.each<[string, () => unknown, unknown]>([
    ["[Chat | Files] at 700 px is one strip", () => isStripView(chatFiles(0.5), wide(700)), true],
    ["[Chat | Files] at 800 px is two panes", () => isStripView(chatFiles(0.5), wide(800)), false],
    [
      "[Files | Diff] at 500 px is two panes",
      () => isStripView(gridLayout(["row", "Files", "Diff"]), wide(500)),
      false,
    ],
    [
      "[Files | side thread] at 700 px is one strip: a side thread's composer needs 360 px",
      () => isStripView(gridLayout(["row", "Files", "thread:side"]), wide(700)),
      true,
    ],
    [
      "[Chat | Files] at 1000 px bounds its divider at the Chat's 360 px",
      () => ratioBounds(chatFiles(0.5), firstDivider(chatFiles(0.5), 1000), wide(1000).size).min,
      0.36,
    ],
    [
      "[Files | Chat] at 1000 px bounds its divider at the Chat's 360 px",
      () =>
        ratioBounds(
          gridLayout(["row", "Files", "Chat"]),
          firstDivider(gridLayout(["row", "Files", "Chat"]), 1000),
          wide(1000).size,
        ).max,
      0.639,
    ],
  ])("%s", (_name, measure, expected) => {
    expect(measure()).toBeCloseTo(expected as number, 6);
  });

  it.each<[string, number, Shape, number | null]>([
    ["splits a lone Chat at 600 px so the Chat keeps 360 px", 600, chatAndFile, 0.6],
    ["opens in a lone Chat's pane at 570 px", 570, ["chat", "file:a.ts"], null],
  ])("%s", (_name, width, expectedShape, ratio) => {
    publishWorkAreaView(wide(width));
    fromChat(() => store().openFile(ref, "a.ts"));
    expect(shape()).toEqual(expectedShape);
    const root = layout().root;
    expect(root.kind === "split" ? root.ratio : null).toBe(ratio);
    expect(isStripView(layout(), wide(width))).toBe(false);
  });

  it.each<[string, (files: TabId) => WorkAreaChange, boolean]>([
    [
      "the only Chat joins the Files pane",
      (files) => ({
        type: "place",
        source: { view: viewOf(PRIMARY_CHAT) },
        at: { kind: "join", pane: holderOf(files)!.id },
      }),
      true,
    ],
    [
      "the only Chat splits the Files pane, leaving no pane behind",
      (files) => ({
        type: "place",
        source: { view: viewOf(PRIMARY_CHAT) },
        at: { kind: "edge", pane: holderOf(files)!.id, edge: "right" },
      }),
      true,
    ],
    [
      "a new Chat does not join the 240 px Files pane",
      (files) => ({
        type: "place",
        source: { threads: [other] },
        at: { kind: "join", pane: holderOf(files)!.id },
      }),
      false,
    ],
    [
      "a new Chat does not split the Chat's pane",
      () => ({
        type: "place",
        source: { threads: [other] },
        at: { kind: "edge", pane: holderOf(PRIMARY_CHAT)!.id, edge: "right" },
      }),
      false,
    ],
    [
      "a lone tab on its own pane's edge changes nothing",
      (files) => ({
        type: "place",
        source: { view: viewOf(files) },
        at: { kind: "edge", pane: holderOf(files)!.id, edge: "bottom" },
      }),
      false,
    ],
  ])("at 600 px, beside a 360 px Chat, %s", (_name, make, fits) => {
    publishWorkAreaView(wide(600));
    fromChat(() => store().openFile(ref, "a.ts"));
    const made = make(tab("file:a.ts"));
    expect(landingRect(layout(), made, ref, record().surfaces, wide(600)) !== null).toBe(fits);
  });

  it.each([
    ["refuses a stale tab menu split of two Chats once the area is 700 px", 700, 1],
    ["splits two Chats while the area is 800 px", 800, 2],
  ])("%s", (_name, width, count) => {
    publishWorkAreaView(wide(width));
    change({
      type: "place",
      source: { threads: [other] },
      at: { kind: "join", pane: paneAt(0).id },
    });
    change({
      type: "place",
      source: { view: viewOf(secondaryChatTabId(other)) },
      at: { kind: "edge", pane: paneAt(0).id, edge: "right" },
    });
    expect(panes()).toHaveLength(count);
    expect(isStripView(layout(), wide(width))).toBe(false);
  });

  it.each<[string, number, number, number | null]>([
    ["clamps a divider write to the Chat's 360 px", 1000, 0.2, 0.36],
    ["keeps a divider with no legal move where it is", 579, 0.2, null],
  ])("%s", (_name, width, ratio, written) => {
    fromChat(() => store().openFile(ref, "a.ts"));
    const split = layout().root;
    if (split.kind !== "split") throw new Error("expected a split");
    change({ type: "ratio", split: split.id, ratio: 0.62 });
    publishWorkAreaView(wide(width));
    change({ type: "ratio", split: split.id, ratio });
    const root = layout().root;
    expect(root.kind === "split" ? root.ratio : null).toBeCloseTo(written ?? 0.62, 6);
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
    change({ type: "activate", view: viewOf(PRIMARY_CHAT) });
    chatBeside("b.ts");
    expect(shape()).toEqual({ axis: "row", first: ["chat", "file:a.ts"], second: ["file:b.ts"] });
    store().activateSurface(ref, "file:a.ts");
    expect(actives()).toEqual(["file:a.ts", "file:b.ts"]);
    expect(focusedIndex()).toBe(0);
  });

  it("moves an automatic reveal off a shown Chat without moving the focus", () => {
    const narrow = publishWorkAreaView({ narrow: true, size: null });
    store().open(ref, "diff");
    narrow();
    change({ type: "activate", view: viewOf(PRIMARY_CHAT) });
    chatBeside("b.ts");
    store().open(ref, "diff", true);
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["file:b.ts", "diff"] });
    expect(actives()).toEqual(["chat", "diff"]);
    expect(focusedIndex()).toBe(1);
  });

  it.each<[string, () => void, () => unknown, Shape, readonly string[]]>([
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
      () => store().reconcileBrowserSurfaces(ref, ["t1"]),
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
      "puts a duplicated browser right after its source, in its source's pane",
      () => {
        publishWorkAreaView(WIDE);
        store().openBrowser(ref, "src");
        store().openFile(ref, "a.ts");
        change({ type: "focus", pane: paneAt(0).id });
      },
      async () => {
        const source = { tabId: "src", navStatus: { _tag: "Idle" } } as never;
        const created = runWithOpenOrigin(
          { record: ref, tab: tab("browser:src"), adjacent: true },
          () => addBrowserSurface({ threadRef: ref, openPreview: vi.fn(), duplicateFrom: source }),
        );
        session.open("dup");
        await created;
      },
      { axis: "row", first: ["chat"], second: ["browser:src", "browser:dup", "file:a.ts"] },
      ["chat", "browser:dup"],
    ],
    [
      "splits beside the shown Chat for a file that replaces an explorer hidden behind it",
      () => {
        const narrow = publishWorkAreaView({ narrow: true, size: null });
        store().open(ref, "files");
        narrow();
        change({ type: "activate", view: viewOf(PRIMARY_CHAT) });
      },
      () => store().openFile(ref, "x.ts"),
      { axis: "row", first: ["chat"], second: ["file:x.ts"] },
      ["chat", "file:x.ts"],
    ],
  ])("%s", async (_name, arrange, act, expectedShape, expectedActives) => {
    arrange();
    await act();
    expect(shape()).toEqual(expectedShape);
    expect(actives()).toEqual(expectedActives);
  });

  it("adds a background browser beside the Chat and treats a removal fallback as maintenance", () => {
    onePane("a.ts");
    change({ type: "activate", view: viewOf(PRIMARY_CHAT) });
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

  it.each<[string, () => void, string]>([
    [
      "a side thread",
      () => fromChat(() => store().openThread(ref, ThreadId.make("side"))),
      "thread:side",
    ],
    [
      "a reply",
      () => chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, ref).openSubThread("m-1"),
      replyTabId(ref, "m-1"),
    ],
  ])("keeps an automatic open from covering %s, as it keeps one off a Chat", (_, open, shown) => {
    publishWorkAreaView(WIDE);
    open();
    store().open(ref, "diff", true);
    expect(actives()).toEqual(["chat", shown, "diff"]);
  });

  it("keeps an automatic open off the shown Chat when no work area is mounted", () => {
    store().open(ref, "diff", true);
    expect(shape()).toEqual(["chat", "diff"]);
    expect(actives()).toEqual(["chat"]);
  });

  it("arms a pane by kind for the next open of that kind and for background adds", () => {
    chatBeside("a.ts");
    change({ type: "arm", armed: { pane: paneAt(0).id, kind: "preview" } });
    store().reconcileBrowserSurfaces(ref, ["t1"]);
    expect(shape()).toEqual({ axis: "row", first: ["chat", "browser:t1"], second: ["file:a.ts"] });
    expect(layout().armed?.kind).toBe("preview");
    store().open(ref, "files", true);
    expect(paneAt(1).tabs).toContain("files");
    expect(layout().armed?.kind).toBe("preview");
    change({ type: "arm", armed: { pane: paneAt(0).id, kind: "diff" } });
    store().open(ref, "diff");
    expect(paneAt(0).tabs).toContain("diff");
    expect(actives()[0]).toBe("diff");
    expect(layout().armed).toBeUndefined();
    change({ type: "arm", armed: { pane: paneAt(0).id, kind: "files" } });
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

  const STRIP = { narrow: true, size: null };
  it.each<[string, WorkAreaView, () => void, Shape, readonly string[]]>([
    [
      "opens a closed diff",
      WIDE,
      () => {},
      { axis: "row", first: ["chat"], second: ["diff"] },
      ["chat", "diff"],
    ],
    ["closes the shown diff", WIDE, () => store().open(ref, "diff"), ["chat"], ["chat"]],
    [
      "shows a diff hidden behind another tab",
      WIDE,
      () => {
        store().open(ref, "diff");
        store().openFile(ref, "a.ts");
      },
      { axis: "row", first: ["chat"], second: ["diff", "file:a.ts"] },
      ["chat", "diff"],
    ],
    ["closes the diff the strip shows", STRIP, () => store().open(ref, "diff"), ["chat"], ["chat"]],
  ])("diff.toggle %s", (_name, view, arrange, expectedShape, expectedActives) => {
    publishWorkAreaView(view);
    arrange();
    toggleDiff(ref);
    expect(shape()).toEqual(expectedShape);
    expect(actives()).toEqual(expectedActives);
  });

  it.each([
    ["panes", WIDE],
    ["the strip view", STRIP],
  ] as const)("preview.toggle hides the shown browser and shows it again, in %s", (_, view) => {
    using _grant = vi.spyOn(sessionState, "readEnvironmentScope").mockReturnValue(true);
    publishWorkAreaView(view);
    const toggle = () => togglePreview(ref);
    const shownIds = () => shownSurfaces(record(), view).map((surface) => surface.id);
    store().openBrowser(ref, "t1");
    expect(shownIds()).toEqual(["browser:t1"]);
    toggle();
    expect(shownIds()).toEqual([]);
    toggle();
    expect(shownIds()).toEqual(["browser:t1"]);
  });
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
      source: { view: viewOf(tab("files")) },
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

  it.each<[string, () => unknown]>([
    [
      "a pull request",
      () =>
        store().openPullRequest(other, {
          projectId: "project",
          repository: "pingdotgg/t3code",
          number: 7,
        }),
    ],
    [
      "an issue",
      () =>
        store().openIssue(other, {
          projectId: "project",
          tracker: "github",
          scope: "o/r",
          key: "7",
        }),
    ],
    [
      "a browser link, after the open's awaits",
      () =>
        openUrlInPreview({
          threadRef: other,
          url: "https://t3.chat/",
          openPreview: async () =>
            AsyncResult.success({ tabId: "t1", navStatus: { _tag: "Idle" } } as never),
        }),
    ],
    [
      "a browser link whose session is listed before the open ends",
      () =>
        openUrlInPreview({
          threadRef: other,
          url: "https://t3.chat/",
          openPreview: async () => {
            store().reconcileBrowserSurfaces(ref, ["t1"]);
            return AsyncResult.success({ tabId: "t1", navStatus: { _tag: "Idle" } } as never);
          },
        }),
    ],
  ])(
    "opens %s from a linked file beside it in the owner's layout once its Chat is gone",
    async (_name, open) => {
      using _defaults = vi
        .spyOn(browserDefaults, "resolveBrowserDefaults")
        .mockResolvedValue(browserDefaults.getBrowserDefaults());
      publishWorkAreaView(WIDE);
      change({ type: "link-file", source: other, path: "notes.md", line: null });
      const linked = linkedFileTabId(other, "notes.md");
      await chatFileTarget({ kind: "shown", owner: ref, tab: linked }, other).run(open);
      const added = record().surfaces.map((surface) => tab(surface.id));
      expect(added).toHaveLength(1);
      expect(shape()).toEqual({ axis: "row", first: ["chat", ...added], second: [linked] });
      expect(selectThreadRightPanelState(store().byThreadKey, other).surfaces).toEqual([]);
    },
  );

  const notes = {
    type: "file" as const,
    id: "notes-1",
    name: "notes.md",
    mimeType: "text/plain",
    sizeBytes: 12,
  };
  it.each<[string, () => void, TabId | null]>([
    ["a workspace file tab", () => chatBeside("a.ts"), tab("file:a.ts")],
    [
      "the Chat beside a file tab",
      () => {
        chatBeside("a.ts");
        change({ type: "focus", pane: paneAt(0).id });
      },
      null,
    ],
    ["an attachment tab", () => store().openAttachment(ref, notes), null],
    [
      "a linked file from another thread",
      () => change({ type: "link-file", source: other, path: "src/x.ts", line: null }),
      linkedFileTabId(other, "src/x.ts"),
    ],
    [
      "a linked attachment from another thread",
      () =>
        change({
          type: "link-file",
          source: other,
          path: "notes.md",
          line: null,
          attachment: notes,
        }),
      null,
    ],
  ])("gives the Open in shortcut to %s when focused", (_name, arrange, owner) => {
    arrange();
    expect(openInFileTab(record())).toBe(owner);
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

  it.each<[string, () => void, () => boolean, Shape, readonly string[], number]>([
    [
      "shows a thread's open Chat tab where it is, adding none",
      () => {
        change({
          type: "place",
          source: { threads: [other] },
          at: { kind: "edge", pane: paneAt(0).id, edge: "right" },
        });
        fromChat(() => store().openFile(ref, "a.ts"));
        change({ type: "focus", pane: paneAt(0).id });
      },
      () => chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, ref).openThread(other),
      { axis: "row", first: ["chat"], second: [secondaryChatTabId(other), "file:a.ts"] },
      ["chat", secondaryChatTabId(other)],
      1,
    ],
    [
      "shows the owner's own Chat for a link to the owner",
      () => onePane("a.ts"),
      () => chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, ref).openThread(ref),
      ["chat", "file:a.ts"],
      ["chat"],
      0,
    ],
    [
      "puts a closed primary Chat back beside the secondary Chat that links to it",
      () => {
        change({
          type: "place",
          source: { threads: [other] },
          at: { kind: "edge", pane: paneAt(0).id, edge: "right" },
        });
        change({ type: "close", tab: PRIMARY_CHAT });
      },
      () =>
        chatFileTarget(
          { kind: "shown", owner: ref, tab: secondaryChatTabId(other) },
          other,
        ).openThread(ref),
      { axis: "row", first: [secondaryChatTabId(other)], second: ["chat"] },
      [secondaryChatTabId(other), "chat"],
      1,
    ],
  ])("%s", (_name, arrange, act, expectedShape, expectedActives, focused) => {
    arrange();
    expect(act()).toBe(true);
    expect(shape()).toEqual(expectedShape);
    expect(actives()).toEqual(expectedActives);
    expect(focusedIndex()).toBe(focused);
  });

  it.each(["the side chat", "the reply tab"])(
    "keeps a shown secondary thread routed to the owner until its last view goes, %s first",
    (first) => {
      const reply = hostShownChat(other, ref)!;
      const sideChat = hostRightPanel(other, ref);
      const [early, late] = first === "the side chat" ? [sideChat, reply] : [reply, sideChat];
      early();
      expect(rightPanelHostRef(other)).toEqual(ref);
      early();
      expect(rightPanelHostRef(other)).toEqual(ref);
      late();
      expect(rightPanelHostRef(other)).toEqual(other);
    },
  );

  it.each<[string, () => void]>([
    ["", () => {}],
    [", its session listed first", () => store().reconcileBrowserSurfaces(ref, ["t1"])],
  ])("opens a chat's browser link beside the Chat after the open's awaits%s", async (_, list) => {
    using _defaults = vi
      .spyOn(browserDefaults, "resolveBrowserDefaults")
      .mockResolvedValue(browserDefaults.getBrowserDefaults());
    publishWorkAreaView(WIDE);
    fromChat(() => store().open(ref, "diff"));
    store().open(ref, "files");
    change({
      type: "place",
      source: { view: viewOf(tab("files")) },
      at: { kind: "edge", pane: paneAt(0).id, edge: "left" },
    });
    const snapshot = { tabId: "t1", navStatus: { _tag: "Idle" } } as never;
    const opened = fromChat(() =>
      openUrlInPreview({
        threadRef: ref,
        url: "https://t3.chat/",
        openPreview: async () => {
          list();
          return AsyncResult.success(snapshot);
        },
      }),
    );
    change({ type: "focus", pane: paneAt(0).id });
    await opened;
    expect(shape()).toEqual({
      axis: "row",
      first: { axis: "row", first: ["files"], second: ["chat"] },
      second: ["diff", "browser:t1"],
    });
  });

  it("shows a browser the user opened before where it is when a chat link opens it again", async () => {
    using _defaults = vi
      .spyOn(browserDefaults, "resolveBrowserDefaults")
      .mockResolvedValue(browserDefaults.getBrowserDefaults());
    publishWorkAreaView(WIDE);
    store().openBrowser(ref, "t1");
    fromChat(() => store().openFile(ref, "a.ts"));
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["browser:t1", "file:a.ts"] });
    await fromChat(() =>
      openUrlInPreview({
        threadRef: ref,
        url: "https://t3.chat/",
        openPreview: async () =>
          AsyncResult.success({ tabId: "t1", navStatus: { _tag: "Idle" } } as never),
      }),
    );
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["browser:t1", "file:a.ts"] });
    expect(actives()).toEqual(["chat", "browser:t1"]);
  });

  it("opens a chat's local page in the browser beside the Chat after the asset lookup", async () => {
    using _defaults = vi
      .spyOn(browserDefaults, "resolveBrowserDefaults")
      .mockResolvedValue(browserDefaults.getBrowserDefaults());
    using _available = vi.spyOn(previewRuntime, "isPreviewAvailableFor").mockReturnValue(true);
    publishWorkAreaView(WIDE);
    fromChat(() => store().open(ref, "diff"));
    store().open(ref, "files");
    change({
      type: "place",
      source: { view: viewOf(tab("files")) },
      at: { kind: "edge", pane: paneAt(0).id, edge: "left" },
    });
    const opened = fromChat(() =>
      openFileInPreview({
        threadRef: ref,
        filePath: "/repo/page.html",
        workspaceRoot: "/repo",
        httpBaseUrl: "http://127.0.0.1:3773",
        createAssetUrl: async () =>
          AsyncResult.success({ relativeUrl: "/api/assets/a/page.html", expiresAt: 0 }),
        openPreview: async () =>
          AsyncResult.success({ tabId: "t1", navStatus: { _tag: "Idle" } } as never),
      }),
    );
    change({ type: "focus", pane: paneAt(0).id });
    await opened;
    expect(shape()).toEqual({
      axis: "row",
      first: { axis: "row", first: ["files"], second: ["chat"] },
      second: ["diff", "browser:t1"],
    });
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
    "a thread link": (target: ReturnType<typeof chatFileTarget>) => target.openThread(third),
    "a reply": (target: ReturnType<typeof chatFileTarget>) => target.openSubThread("m-1"),
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
      store().openThread(ref, side.threadId);
      return [sideThreadEmbedding(side.threadId, ref.threadId, ref, {}).origin, side];
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
  // A thread link with no chat around it navigates instead.
  const opensNothing = new Set(["markdown with no chat around it, as sourceless/a thread link"]);
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
      const opened = opens[open](chatFileTarget(origin, thread));
      const added = [...allTabs()].filter((tab) => !before.has(tab));
      if (opensNothing.has(`${name}/${open}`)) {
        expect([opened, added]).toEqual([false, []]);
        return;
      }
      expect(added).toHaveLength(1);
      const pane = panes().findIndex((candidate) => candidate.tabs.includes(added[0]!));
      expect([pane, panes().length]).toEqual(expected[name]);
    } finally {
      unhost();
    }
  });

  it("reads a hosted Chat's side thread's files in its own workspace, with no tool diff or Run", () => {
    const guestSide = scopeThreadRef(env, ThreadId.make("thread-guest-side"));
    const panel = { openToolDiff: () => {}, runShellCommand: () => {} };
    store().openThread(ref, guestSide.threadId);
    const own = sideThreadEmbedding(guestSide.threadId, ref.threadId, ref, panel);
    const guest = sideThreadEmbedding(guestSide.threadId, other.threadId, ref, panel);
    expect(own.parentPanel).toBe(panel);
    expect(guest.parentPanel).toEqual({});
    chatFileTarget(guest.origin, guestSide).openFile("a.ts");
    expect(record().surfaces.map((surface) => surface.kind)).toEqual(["thread"]);
    expect(panes().flatMap((pane) => pane.tabs)).toContain(linkedFileTabId(guestSide, "a.ts"));
  });

  const far = scopeThreadRef(EnvironmentId.make("env-2"), ThreadId.make("thread-far"));
  it("navigates for a thread link no shell or detail places in the owner's project", () => {
    const opener = (thread = ref) => chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, thread);
    expect(openThreadTab(opener, far)).toBe(false);
    expect(openThreadTab(opener, other)).toBe(false);
    expect(layout().tabs[secondaryChatTabId(far)]).toBeUndefined();
    expect(layout().tabs[secondaryChatTabId(other)]).toBeUndefined();
  });

  it.each<[string, ScopedThreadRef, Record<string, string | null>, boolean]>([
    ["the same environment and root", other, {}, true],
    ["another environment", far, {}, false],
    ["another root", other, { [scopedThreadKey(other)]: "/elsewhere" }, false],
    ["a null root", other, { [scopedThreadKey(ref)]: null, [scopedThreadKey(other)]: null }, false],
  ])(
    "shows a mounted secondary Chat's board link from %s, else says why not",
    (_name, guest, roots, shown) => {
      vi.stubGlobal("window", new EventTarget());
      vi.stubGlobal("document", new EventTarget());
      for (const [key, root] of Object.entries(roots)) projectRoots.set(key, root);
      using toast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
      using _mounted = { [Symbol.dispose]: hostShownChat(guest, ref) ?? (() => {}) };
      chatFileTarget(
        { kind: "shown", owner: ref, tab: secondaryChatTabId(guest) },
        guest,
      ).openBoardRef("board://r/1,2,3,4");
      const listsBoard = (thread: ScopedThreadRef) =>
        selectThreadRightPanelState(store().byThreadKey, thread).surfaces.some(
          (surface) => surface.kind === "whiteboard",
        );
      expect({
        owner: listsBoard(ref),
        guest: listsBoard(guest),
        toasts: toast.mock.calls,
      }).toEqual({
        owner: shown,
        guest: false,
        toasts: shown
          ? []
          : [[expect.objectContaining({ title: WORK_AREA_COPY.boardInOtherProject })]],
      });
    },
  );

  it.each([
    ["the owner's environment", other, ref],
    ["another environment", far, far],
  ])("routes a shown secondary Chat's panel actions from %s", (_name, guest, host) => {
    using _mounted = { [Symbol.dispose]: hostShownChat(guest, ref) ?? (() => {}) };
    expect(rightPanelHostRef(guest)).toEqual(host);
  });
});
