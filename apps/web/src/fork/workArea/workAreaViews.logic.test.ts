import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { linkedThreadSurface } from "~/linkedThreadSurface";

import {
  pullRequestSurface,
  type RightPanelKind,
  type RightPanelSurface,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import { chatFileTarget } from "./chatFileOpener";
import { inStripView, planDrop, type PaneGeometry } from "./dropPlan.logic";
import { withChatClosing } from "./tabStrip";
import {
  asPaneId,
  holders,
  leaves,
  type PaneId,
  parseViewKey,
  PRIMARY_CHAT,
  replyTabId,
  secondaryChatTabId,
  stripEntries,
  type TabId,
  viewKey,
  type WorkAreaLayout,
} from "./workArea.logic";
import { followViewScopes, viewScope } from "./viewReading";
import { closeFocusedTab, closeTab, closeViews } from "./workAreaCommands";
import { drawWorkArea, NO_VIEW } from "./workAreaGeometry.logic";
import { applyWorkAreaChange, reconcileWorkArea, repairWorkArea } from "./workAreaPlacement.logic";
import { restoredRecord } from "./workAreaStorage.logic";
import {
  actives,
  change,
  focusedIndex,
  layout,
  other,
  record,
  ref,
  resetWorkAreaStore,
  shape,
  store,
  tab,
  WIDE,
} from "./workAreaTestKit";
import { publishWorkAreaView, runWithOpenOrigin } from "./workAreaView";

type Node =
  | { readonly kind: "pane"; readonly id: string; readonly tabs: string[]; readonly active: string }
  | {
      readonly kind: "split";
      readonly id: string;
      readonly axis: "row" | "column";
      readonly ratio: number;
      readonly first: Node;
      readonly second: Node;
    };

const pane = (id: string, tabs: string[], active = tabs[0]!): Node => ({
  kind: "pane",
  id,
  tabs,
  active,
});
let splits = 10;
const split =
  (axis: "row" | "column") =>
  (first: Node, second: Node): Node => ({
    kind: "split",
    id: `s${(splits += 1)}`,
    axis,
    ratio: 0.5,
    first,
    second,
  });
const row = split("row");
const column = split("column");

const file = (path: string): RightPanelSurface => ({
  id: `file:${path}`,
  kind: "file",
  relativePath: path,
  revealLine: null,
  revealRequestId: 0,
});
const browser = (id: string): RightPanelSurface => ({
  id: `browser:${id}`,
  kind: "preview",
  resourceId: id,
});
const otherChat = secondaryChatTabId(other);
const CHAT_PAYLOADS = {
  [PRIMARY_CHAT]: { kind: "primary-chat" },
  [otherChat]: { kind: "secondary-chat", thread: other, placement: 1 },
} as const;

/** Puts a saved layout into `ref`'s record as a reload would, so the write path repairs it. */
function seat(surfaces: RightPanelSurface[], root: Node, focused = "p0") {
  const placed = new Set<string>();
  const visit = (node: Node) => {
    if (node.kind === "pane") for (const id of node.tabs) placed.add(id);
    else {
      visit(node.first);
      visit(node.second);
    }
  };
  visit(root);
  const tabs = Object.fromEntries(
    [...placed].map((id) => [
      id,
      CHAT_PAYLOADS[id as keyof typeof CHAT_PAYLOADS] ?? { kind: "surface" },
    ]),
  );
  const restored = restoredRecord({
    isOpen: true,
    activeSurfaceId: null,
    surfaces,
    workArea: { root, tabs, focused, seq: 30 },
  } as unknown as ThreadRightPanelState);
  useRightPanelStore.setState({ byThreadKey: { [scopedThreadKey(ref)]: restored } });
}

const view = (paneId: string, id: string) => ({ pane: asPaneId(paneId), tab: tab(id) });
const panesOf = (current: WorkAreaLayout = layout()) =>
  leaves(current.root).map((node) => ({ id: node.id, tabs: node.tabs, active: node.active }));
const NARROW = { narrow: true, size: null } as const;

beforeEach(() => {
  resetWorkAreaStore();
  publishWorkAreaView(WIDE);
});

describe("how many views a tab may have", () => {
  // Exhaustive, so a new upstream kind does not compile until it has a row here and in TRAITS.
  const SURFACES: Record<RightPanelKind, RightPanelSurface> = {
    preview: browser("t1"),
    device: { id: "device", kind: "device" },
    terminal: {
      id: "terminal:t1",
      kind: "terminal",
      resourceId: "t1",
      terminalIds: ["t1"],
      activeTerminalId: "t1",
    },
    diff: { id: "diff", kind: "diff" },
    files: { id: "files", kind: "files" },
    file: file("a.ts"),
    "pull-request": pullRequestSurface({ projectId: "proj", repository: "o/r", number: 7 }),
    "pull-requests": { id: "pull-requests", kind: "pull-requests" },
    issue: {
      id: "issue:proj:github:o/r:1",
      kind: "issue",
      projectId: "proj",
      tracker: "github",
      scope: "o/r",
      key: "1",
    },
    thread: { id: "thread:side", kind: "thread", threadId: ThreadId.make("side") },
    "linked-thread": linkedThreadSurface({
      viaEnvironmentId: EnvironmentId.make("via"),
      environmentId: EnvironmentId.make("env-2"),
      threadId: ThreadId.make("t9"),
      label: "Linked",
      title: "Linked thread",
    }),
    dashboard: { id: "dashboard", kind: "dashboard" },
    replies: { id: "replies", kind: "replies" },
    whiteboard: { id: "whiteboard", kind: "whiteboard" },
  };
  const ONE_VIEW = new Set<RightPanelKind>([
    "preview",
    "device",
    "terminal",
    "files",
    "whiteboard",
  ]);

  it.each(Object.entries(SURFACES))(
    "an Alt-drag of a %s tab into another pane copies a content tab and moves a single one",
    (kind, surface) => {
      seat(
        [surface, file("b.ts")],
        row(pane("p0", ["chat"]), pane("p1", [surface.id, "file:b.ts"])),
      );
      change({
        type: "place",
        source: { view: view("p1", surface.id), copy: true },
        at: { kind: "join", pane: asPaneId("p0") },
      });
      const holding = holders(layout().root, tab(surface.id)).map((node) => node.id);
      expect(holding).toEqual(ONE_VIEW.has(kind as RightPanelKind) ? ["p0"] : ["p0", "p1"]);
    },
  );

  it.each([
    ["a secondary Chat", otherChat, true],
    ["a reply tab", replyTabId(ref, "m-1"), true],
    ["the primary Chat", PRIMARY_CHAT, false],
  ])("an Alt-drag of %s copies it only when it may have several views", (_, id, copies) => {
    publishWorkAreaView({ narrow: false, size: { width: 1600, height: 800 } });
    change({
      type: "place",
      source: { threads: [other] },
      at: { kind: "join", pane: asPaneId("p0") },
    });
    change({ type: "open-reply", thread: ref, first: "m-1" });
    const from = holders(layout().root, id)[0]!.id;
    const to = leaves(layout().root).find((node) => node.id !== from)!.id;
    change({
      type: "place",
      source: { view: { pane: from, tab: id }, copy: true },
      at: { kind: "join", pane: to },
    });
    expect(holders(layout().root, id).length).toBe(copies ? 2 : 1);
  });

  it("names a view by pane and tab, a tab id holding '/' included", () => {
    const named = { pane: asPaneId("p3"), tab: tab("file:src/a/b.ts") };
    expect(parseViewKey(viewKey(named))).toEqual(named);
    expect(parseViewKey("file:src/a.ts")).toBeNull();
  });
});

describe("the layout repair", () => {
  it("keeps a content tab in two panes, folds a double inside one pane and keeps the first browser", () => {
    seat(
      [file("a.ts"), browser("t1")],
      row(
        pane("p0", ["chat", "file:a.ts", "browser:t1"]),
        pane("p1", ["file:a.ts", "file:a.ts", "browser:t1"]),
      ),
    );
    expect(panesOf()).toEqual([
      { id: "p0", tabs: ["chat", "file:a.ts", "browser:t1"], active: "chat" },
      { id: "p1", tabs: ["file:a.ts"], active: "file:a.ts" },
    ]);
    expect(repairWorkArea(layout(), record().surfaces)).toBe(layout());
  });
});

describe("a write that names only a tab", () => {
  it("shows a file open in two panes in the focused pane's view when clicked", () => {
    seat(
      [file("a.ts"), file("b.ts")],
      row(pane("p0", ["chat", "file:a.ts"]), pane("p1", ["file:b.ts", "file:a.ts"])),
      "p1",
    );
    store().openFile(ref, "a.ts");
    expect(actives()).toEqual(["chat", "file:a.ts"]);
    expect(focusedIndex()).toBe(1);
  });

  it("opens a file link from a Chat's second view beside that view", () => {
    publishWorkAreaView({ narrow: false, size: { width: 1200, height: 900 } });
    seat(
      [file("x.ts"), file("y.ts")],
      column(
        row(pane("p0", [otherChat]), pane("p1", ["file:x.ts"])),
        row(pane("p2", [otherChat]), pane("p3", ["file:y.ts"])),
      ),
      "p2",
    );
    chatFileTarget({ kind: "shown", owner: ref, tab: otherChat }, other, asPaneId("p2")).openFile(
      "n.ts",
    );
    const linked = Object.keys(layout().tabs).find((id) => id.startsWith("linked:"))!;
    expect(holders(layout().root, tab(linked)).map((node) => node.id)).toEqual(["p3"]);
  });

  it("lands an adjacent open right after the origin's own view", () => {
    seat([], row(pane("p0", [otherChat, "chat"]), pane("p1", [otherChat])), "p0");
    runWithOpenOrigin({ record: ref, tab: otherChat, pane: asPaneId("p1"), adjacent: true }, () =>
      store().openFile(ref, "n.ts"),
    );
    expect(panesOf().map((node) => node.tabs)).toEqual([
      [otherChat, "chat"],
      [otherChat, "file:n.ts"],
    ]);
  });

  // An automatic open must keep a view another pane already shows, and cover nothing.
  describe("an automatic open of a tab another pane shows", () => {
    const diffAndFile = [{ id: "diff", kind: "diff" } as const, file("a.ts"), file("b.ts")];
    const automatic = (activeSurfaceId: string) => {
      const before = record();
      const next = reconcileWorkArea(before, { ...before, activeSurfaceId }, "automatic", WIDE);
      return next.workArea ?? before.workArea!;
    };

    it("keeps the hidden view in the focused pane", () => {
      seat(diffAndFile, row(pane("p0", ["chat", "diff"]), pane("p1", ["diff", "file:a.ts"])), "p0");
      const before = panesOf();
      expect(panesOf(automatic("diff"))).toEqual(before);
    });

    it("does not cover the focused pane's file", () => {
      seat(
        diffAndFile,
        row(
          pane("p0", ["chat", "file:b.ts", "diff"], "file:b.ts"),
          pane("p1", ["diff", "file:a.ts"]),
        ),
        "p0",
      );
      const before = panesOf();
      expect(panesOf(automatic("diff"))).toEqual(before);
    });

    it("keeps a pull request view the user put in another pane when the store follows it", () => {
      const pr = pullRequestSurface({ projectId: "proj", repository: "o/r", number: 7 });
      seat(
        [pr, file("a.ts")],
        row(pane("p0", ["chat", pr.id]), pane("p1", [pr.id, "file:a.ts"])),
        "p0",
      );
      const before = panesOf();
      store().openProactive(ref, pr, 0, true);
      expect(panesOf()).toEqual(before);
    });
  });
});

describe("closing one of several views", () => {
  const twoFileViews = () =>
    seat(
      [file("a.ts"), file("b.ts")],
      row(pane("p0", ["chat", "file:a.ts"], "file:a.ts"), pane("p1", ["file:a.ts", "file:b.ts"])),
      "p0",
    );

  it("closes only that view, and the tab's last view through the surface's close path", () => {
    twoFileViews();
    const closeSurface = vi.fn((surface: RightPanelSurface) =>
      store().closeSurface(ref, surface.id),
    );
    closeTab(ref, [view("p1", "file:a.ts")], closeSurface);
    expect(closeSurface).not.toHaveBeenCalled();
    expect(panesOf().map((node) => node.tabs)).toEqual([["chat", "file:a.ts"], ["file:b.ts"]]);
    closeTab(ref, [view("p0", "file:a.ts")], closeSurface);
    expect(closeSurface).toHaveBeenCalledOnce();
    expect(record().surfaces.map((surface) => surface.id)).toEqual(["file:b.ts"]);
  });

  it("refuses to close a tab's last view alone", () => {
    twoFileViews();
    change({ type: "close-view", view: view("p1", "file:b.ts") });
    expect(record().surfaces.map((surface) => surface.id)).toContain("file:b.ts");
    expect(panesOf().map((node) => node.tabs)).toEqual([
      ["chat", "file:a.ts"],
      ["file:a.ts", "file:b.ts"],
    ]);
  });

  it("removes every view when the content itself closes", () => {
    twoFileViews();
    store().closeSurface(ref, "file:a.ts");
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["file:b.ts"] });
  });

  it("bulk-closes in one pane: a view kept elsewhere alone, after the surfaces confirm", () => {
    twoFileViews();
    let confirm: () => void = () => {};
    const closeSurfaces = vi.fn((surfaces: RightPanelSurface[], after: () => void) => {
      confirm = () => {
        for (const surface of surfaces) store().closeSurface(ref, surface.id);
        after();
      };
    });
    closeViews(ref, [view("p1", "file:a.ts"), view("p1", "file:b.ts")], closeSurfaces);
    expect(closeSurfaces.mock.calls[0]![0].map((surface) => surface.id)).toEqual(["file:b.ts"]);
    expect(holders(layout().root, tab("file:a.ts"))).toHaveLength(2);
    confirm();
    expect(shape()).toEqual(["chat", "file:a.ts"]);
    expect(record().surfaces.map((surface) => surface.id)).toEqual(["file:a.ts"]);
  });

  // In the one strip the keyboard close and the strip's X both close the tab.
  it("closes the tab, every view, with rightPanel.close in the one strip", () => {
    seat(
      [file("a.ts"), file("b.ts")],
      row(pane("p0", ["file:a.ts", "file:b.ts"]), pane("p1", ["chat", "file:a.ts"])),
      "p0",
    );
    publishWorkAreaView(NARROW);
    closeFocusedTab(ref, (surface) => store().closeSurface(ref, surface.id));
    expect(drawWorkArea(layout(), NARROW).panes[0]!.tabs).toEqual(["file:b.ts", "chat"]);
  });

  it("closes only the focused view with rightPanel.close in panes", () => {
    seat(
      [file("a.ts"), file("b.ts")],
      row(pane("p0", ["file:a.ts", "file:b.ts"]), pane("p1", ["chat", "file:a.ts"])),
      "p0",
    );
    const closeSurface = vi.fn();
    closeFocusedTab(ref, closeSurface);
    expect(closeSurface).not.toHaveBeenCalled();
    expect(panesOf().map((node) => node.tabs)).toEqual([["file:b.ts"], ["chat", "file:a.ts"]]);
  });

  // A Chat in two panes is one Chat; its tab close stays refused while it is the last one.
  describe("the last Chat with two views", () => {
    const lastChatTwice = () =>
      seat(
        [file("a.ts")],
        row(pane("p0", [otherChat, "file:a.ts"]), pane("p1", [otherChat])),
        "p0",
      );
    const chatEntry = (strip: boolean, tabs: readonly TabId[]) => {
      const entries = stripEntries(layout(), record(), tabs, ref, "Chat", strip);
      const entry = entries.find((candidate) => candidate.id === otherChat)!;
      return {
        entry,
        close: withChatClosing([{ id: "close", label: "Close" }], entry, entries)[0]!,
      };
    };

    it("keeps the one strip's X off and refuses the strip's close of every view", () => {
      lastChatTwice();
      publishWorkAreaView(NARROW);
      const { close } = chatEntry(true, drawWorkArea(layout(), NARROW).panes[0]!.tabs);
      expect(close.disabled).toBe(true);
      const allViews = holders(layout().root, otherChat).map((node) => ({
        pane: node.id,
        tab: otherChat,
      }));
      closeTab(ref, allViews, vi.fn());
      expect(holders(layout().root, otherChat)).toHaveLength(2);
      expect(holders(layout().root, PRIMARY_CHAT)).toHaveLength(0);
    });

    it("closes one of its views in panes", () => {
      lastChatTwice();
      expect(chatEntry(false, [otherChat]).close.disabled).toBeUndefined();
      closeTab(ref, [view("p1", otherChat)], vi.fn());
      expect(panesOf().map((node) => node.tabs)).toEqual([[otherChat, "file:a.ts"]]);
    });
  });
});

describe("pressing and dragging views", () => {
  const twoFileViews = () =>
    seat(
      [file("a.ts"), file("b.ts")],
      row(pane("p0", ["chat", "file:a.ts"]), pane("p1", ["file:a.ts", "file:b.ts"], "file:b.ts")),
      "p0",
    );

  it("activates and focuses the pressed view's own pane", () => {
    twoFileViews();
    change({ type: "activate", view: view("p1", "file:a.ts") });
    expect(actives()).toEqual(["chat", "file:a.ts"]);
    expect(focusedIndex()).toBe(1);
    const settled = layout();
    change({ type: "activate", view: view("p0", "file:b.ts") });
    expect(layout()).toBe(settled);
  });

  it("moves only the dragged view, into a pane holding the tab, which keeps its slot", () => {
    twoFileViews();
    change({
      type: "place",
      source: { view: view("p1", "file:a.ts") },
      at: { kind: "join", pane: asPaneId("p0") },
    });
    expect(panesOf()).toEqual([
      { id: "p0", tabs: ["chat", "file:a.ts"], active: "file:a.ts" },
      { id: "p1", tabs: ["file:b.ts"], active: "file:b.ts" },
    ]);
  });

  it("copies with Alt, and a copy splits its own lone tab", () => {
    seat([file("a.ts")], row(pane("p0", ["chat"]), pane("p1", ["file:a.ts"])), "p1");
    change({
      type: "place",
      source: { view: view("p1", "file:a.ts"), copy: true },
      at: { kind: "edge", pane: asPaneId("p1"), edge: "right" },
    });
    expect(shape()).toEqual({
      axis: "row",
      first: ["chat"],
      second: { axis: "row", first: ["file:a.ts"], second: ["file:a.ts"] },
    });
  });

  it("moves every view of a tab dropped in the one strip", () => {
    twoFileViews();
    publishWorkAreaView(NARROW);
    change({
      type: "place",
      source: { view: view("p1", "file:a.ts") },
      at: { kind: "strip", pane: asPaneId("p1"), before: tab("file:b.ts") },
    });
    expect(panesOf().map((node) => node.tabs)).toEqual([["chat"], ["file:a.ts", "file:b.ts"]]);
  });

  // The one strip draws a tab where it first occurs, so a drop before it goes there.
  it("drops before the drawn tab in the one strip when its tab has a second view", () => {
    const narrow = { narrow: true, size: { width: 400, height: 800 } };
    seat(
      [file("a"), file("b"), file("x")],
      row(
        pane("p0", ["chat", "file:a", "file:x"], "file:a"),
        pane("p1", ["file:a", "file:b"], "file:b"),
      ),
      "p1",
    );
    const current = layout();
    const drawn = drawWorkArea(current, narrow).panes[0]!;
    expect(drawn.tabs).toEqual(["chat", "file:a", "file:x", "file:b"]);
    const frame = { left: 0, right: 400, top: 0, bottom: 800 };
    const strip: PaneGeometry = {
      id: drawn.id,
      frame,
      strip: { ...frame, bottom: 36 },
      tabs: drawn.tabs.map((id, index) => ({
        id,
        box: { left: index * 80, right: (index + 1) * 80, top: 0, bottom: 36 },
      })),
    };
    const subject = { kind: "tab" as const, tab: tab("file:b"), from: drawn.id };
    const plan = inStripView(
      planDrop([strip], { x: 100, y: 18 }, subject, () => frame),
      current.root,
    );
    const dropped = applyWorkAreaChange(
      current,
      { type: "place", source: { view: view("p1", "file:b") }, at: plan!.at },
      ref,
      record().surfaces,
      narrow,
    );
    expect(drawWorkArea(dropped, narrow).panes[0]!.tabs).toEqual([
      "chat",
      "file:b",
      "file:a",
      "file:x",
    ]);
  });
});

// Find keeps the search field of the Chat view it runs in.
describe("a Find reveal from a Chat open in two panes", () => {
  it("keeps the searched view on its Chat and shows the reply in the other pane", () => {
    publishWorkAreaView({ narrow: false, size: { width: 1600, height: 800 } });
    const reply = replyTabId(other, "m-1");
    const start: WorkAreaLayout = {
      root: {
        kind: "split",
        id: "s2" as never,
        axis: "row",
        ratio: 0.5,
        first: { kind: "pane", id: asPaneId("p0"), tabs: [otherChat, reply], active: otherChat },
        second: {
          kind: "pane",
          id: asPaneId("p1"),
          tabs: [PRIMARY_CHAT, otherChat],
          active: otherChat,
        },
      },
      tabs: {
        ...CHAT_PAYLOADS,
        [reply]: { kind: "sub-thread", thread: other, first: "m-1" },
      } as WorkAreaLayout["tabs"],
      focused: asPaneId("p0"),
      seq: 3,
    };
    const next = applyWorkAreaChange(
      start,
      { type: "open-reply", thread: other, first: "m-1", reveal: "find" },
      ref,
      [],
      { narrow: false, size: { width: 1600, height: 800 } },
      { tab: otherChat, pane: asPaneId("p0") },
    );
    const activeIn = (id: PaneId) => leaves(next.root).find((node) => node.id === id)?.active;
    expect(activeIn(asPaneId("p0"))).toBe(otherChat);
    expect(activeIn(asPaneId("p1"))).toBe(reply);
    expect(next.focused).toBe("p0");
  });

  it("in the one strip, moves one view of the reply after the searched Chat and keeps its other views", () => {
    publishWorkAreaView(NARROW);
    const reply = replyTabId(other, "m-1");
    const start: WorkAreaLayout = {
      root: {
        kind: "split",
        id: "s2" as never,
        axis: "row",
        ratio: 0.5,
        first: {
          kind: "pane",
          id: asPaneId("p0"),
          tabs: [otherChat, "file:a" as TabId],
          active: otherChat,
        },
        second: {
          kind: "split",
          id: "s3" as never,
          axis: "column",
          ratio: 0.5,
          first: { kind: "pane", id: asPaneId("p1"), tabs: [reply], active: reply },
          second: { kind: "pane", id: asPaneId("p2"), tabs: [PRIMARY_CHAT, reply], active: reply },
        },
      },
      tabs: {
        ...CHAT_PAYLOADS,
        "file:a": { kind: "surface" },
        [reply]: { kind: "sub-thread", thread: other, first: "m-1" },
      } as WorkAreaLayout["tabs"],
      focused: asPaneId("p0"),
      seq: 4,
    };
    const next = applyWorkAreaChange(
      start,
      { type: "open-reply", thread: other, first: "m-1", reveal: "find" },
      ref,
      [file("a")],
      NARROW,
      { tab: otherChat, pane: asPaneId("p0") },
    );
    const panesNow = Object.fromEntries(
      leaves(next.root).map((node) => [node.id, { tabs: node.tabs, active: node.active }]),
    );
    // The first view shown moves, so its pane closes; the other view stays.
    expect(panesNow).toEqual({
      p0: { tabs: [otherChat, reply, "file:a"], active: reply },
      p2: { tabs: [PRIMARY_CHAT, reply], active: reply },
    });
    expect(next.focused).toBe("p0");
  });

  it("in the one strip, moves a reply's one view after the searched Chat", () => {
    publishWorkAreaView(NARROW);
    const reply = replyTabId(other, "m-1");
    const start: WorkAreaLayout = {
      root: {
        kind: "split",
        id: "s2" as never,
        axis: "row",
        ratio: 0.5,
        first: {
          kind: "pane",
          id: asPaneId("p0"),
          tabs: [otherChat, "file:a" as TabId],
          active: otherChat,
        },
        second: {
          kind: "split",
          id: "s3" as never,
          axis: "column",
          ratio: 0.5,
          first: { kind: "pane", id: asPaneId("p1"), tabs: [reply], active: reply },
          second: { kind: "pane", id: asPaneId("p2"), tabs: [PRIMARY_CHAT], active: PRIMARY_CHAT },
        },
      },
      tabs: {
        ...CHAT_PAYLOADS,
        "file:a": { kind: "surface" },
        [reply]: { kind: "sub-thread", thread: other, first: "m-1" },
      } as WorkAreaLayout["tabs"],
      focused: asPaneId("p0"),
      seq: 4,
    };
    const next = applyWorkAreaChange(
      start,
      { type: "open-reply", thread: other, first: "m-1", reveal: "find" },
      ref,
      [file("a")],
      NARROW,
      { tab: otherChat, pane: asPaneId("p0") },
    );
    expect(panesOf(next)).toEqual([
      { id: "p0", tabs: [otherChat, reply, "file:a"], active: reply },
      { id: "p2", tabs: [PRIMARY_CHAT], active: PRIMARY_CHAT },
    ]);
    expect(next.focused).toBe("p0");
  });
});

describe("a file view's own reading place", () => {
  const scope = (paneId: string, id: string) => viewScope(scopedThreadKey(ref), view(paneId, id));
  function followScopes() {
    const calls: string[] = [];
    const stop = followViewScopes(
      {
        forgetScope: (ended) => calls.push(`forget ${ended}`),
        moveScope: (from, to) => calls.push(`move ${from} to ${to}`),
      },
      useRightPanelStore,
    );
    return { calls, [Symbol.dispose]: stop };
  }

  it("moves with its view to another pane and ends when the view closes", () => {
    seat(
      [file("a")],
      row(pane("p0", ["chat"]), column(pane("p1", ["file:a"]), pane("p2", ["file:a"]))),
    );
    using scopes = followScopes();
    change({
      type: "place",
      source: { view: view("p1", "file:a") },
      at: { kind: "join", pane: asPaneId("p0") },
    });
    expect(scopes.calls).toEqual([`move ${scope("p1", "file:a")} to ${scope("p0", "file:a")}`]);

    scopes.calls.length = 0;
    change({ type: "close-view", view: view("p2", "file:a") });
    expect(scopes.calls).toEqual([`forget ${scope("p2", "file:a")}`]);
  });

  it("gives a copy no place of its own", () => {
    seat([file("a"), file("b")], row(pane("p0", ["chat", "file:a"]), pane("p1", ["file:b"])));
    using scopes = followScopes();
    change({
      type: "place",
      source: { view: view("p0", "file:a"), copy: true },
      at: { kind: "join", pane: asPaneId("p1") },
    });
    expect(holders(layout().root, tab("file:a")).map((node) => node.id)).toEqual(["p0", "p1"]);
    expect(scopes.calls).toEqual([]);
  });
});

describe("saved layouts", () => {
  it("restores a file open in two panes with both views", () => {
    seat([file("a.ts")], row(pane("p0", ["chat", "file:a.ts"]), pane("p1", ["file:a.ts"])));
    expect(shape()).toEqual({ axis: "row", first: ["chat", "file:a.ts"], second: ["file:a.ts"] });
    expect(drawWorkArea(layout(), NO_VIEW).panes).toHaveLength(2);
  });
});
