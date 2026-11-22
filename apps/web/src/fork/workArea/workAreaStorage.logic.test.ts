import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import {
  type LayoutNode,
  leaves,
  linkedFileEntry,
  linkedFileTabId,
  PRIMARY_CHAT,
  replyTabId,
  secondaryChatTabId,
  stripEntries,
  type TabId,
} from "./workArea.logic";
import { drawWorkArea, shownSurfaces } from "./workAreaGeometry.logic";
import { repairWorkArea } from "./workAreaPlacement.logic";
import { mergePersistedWorkArea, persistedRecord, restoreWorkArea } from "./workAreaStorage.logic";
import {
  actives,
  change,
  chatBeside,
  layout,
  onePane,
  other,
  paneAt,
  record,
  ref,
  resetWorkAreaStore,
  type Shape,
  shape,
  shapeOf,
  store,
  WIDE,
} from "./workAreaTestKit";

beforeEach(resetWorkAreaStore);

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

  it("keeps a layout across a storage version bump, with a side chat tab under its new id", async () => {
    chatBeside("a.ts");
    store().openThread(ref, ThreadId.make("side"));
    const split = layout().root;
    if (split.kind !== "split") throw new Error("expected a split");
    change({ type: "ratio", split: split.id, ratio: 0.7 });
    const before = layout().root;
    expect(JSON.stringify(before)).toContain('"thread:side"');

    const { storage, name } = useRightPanelStore.persist.getOptions();
    const saved = JSON.stringify((await storage!.getItem(name!))!);
    const older = JSON.parse(
      saved
        .replaceAll('"thread:side"', '"side-chat:side"')
        .replaceAll('"kind":"thread"', '"kind":"side-chat"'),
    );
    useRightPanelStore.setState(useRightPanelStore.getInitialState());
    await storage!.setItem(name!, { ...older, version: 15 });
    await useRightPanelStore.persist.rehydrate();
    expect(layout().root).toEqual(before);
  });

  const openPanel: Shape = { axis: "row", first: ["chat"], second: ["file:a", "file:b", "file:c"] };
  it.each<[string, boolean, unknown, Shape, readonly string[], string | null, readonly number[]]>([
    ["an open panel", true, undefined, openPanel, ["chat", "file:b"], "file:b", [0.5]],
    [
      "a closed panel",
      false,
      undefined,
      ["chat", "file:a", "file:b", "file:c"],
      ["chat"],
      null,
      [],
    ],
    [
      "an open panel split into two groups",
      true,
      { rightIds: ["file:c"], otherShownId: "file:c", ratio: 0.3 },
      {
        axis: "row",
        first: ["chat"],
        second: { axis: "row", first: ["file:a", "file:b"], second: ["file:c"] },
      },
      ["chat", "file:b", "file:c"],
      "file:b",
      [0.5, 0.3],
    ],
    [
      "a closed panel split into two groups",
      false,
      { rightIds: ["file:c"], otherShownId: "file:c", ratio: 0.3 },
      {
        axis: "row",
        first: ["chat"],
        second: { axis: "row", first: ["file:a", "file:b"], second: ["file:c"] },
      },
      ["chat", "file:b", "file:c"],
      null,
      [0.5, 0.3],
    ],
    [
      "a split it cannot read",
      true,
      { rightIds: "file:c", otherShownId: 3 },
      openPanel,
      ["chat", "file:b"],
      "file:b",
      [0.5],
    ],
  ])(
    "seeds a layout from an older build's record with %s",
    (_name, isOpen, split, expected, active, mirror, ratios) => {
      const file = (name: string) => ({
        id: `file:${name}`,
        kind: "file",
        relativePath: name,
        revealLine: null,
        revealRequestId: 1,
      });
      const older = {
        isOpen,
        activeSurfaceId: "file:b",
        surfaces: [file("a"), file("b"), file("c")],
        ...(split === undefined ? {} : { split }),
      };
      const merged = mergePersistedWorkArea(
        { byThreadKey: { [scopedThreadKey(ref)]: older } },
        useRightPanelStore.getInitialState(),
      );
      useRightPanelStore.setState({ byThreadKey: merged.byThreadKey });
      expect(shape()).toEqual(expected);
      expect(actives()).toEqual(active);
      expect(record().activeSurfaceId).toBe(mirror);
      const ratiosOf = (node: LayoutNode): number[] =>
        node.kind === "pane" ? [] : [node.ratio, ...ratiosOf(node.first), ...ratiosOf(node.second)];
      expect(ratiosOf(layout().root)).toEqual(ratios);
    },
  );

  it.each<[string, Record<string, unknown>, boolean]>([
    ["a launcher", { launcher: { kind: "launcher" } }, true],
    ["a surface that claims the launcher's id", { launcher: { kind: "surface" } }, false],
    ["a launcher under another id", { files: { kind: "launcher" } }, false],
    [
      "a reply tab",
      { [replyTabId(other, "m-1")]: { kind: "sub-thread", thread: other, first: "m-1" } },
      true,
    ],
    [
      "a reply tab under another reply's id",
      { [replyTabId(other, "m-2")]: { kind: "sub-thread", thread: other, first: "m-1" } },
      false,
    ],
    [
      "a surface that claims a reply's id",
      { [replyTabId(other, "m-1")]: { kind: "surface" } },
      false,
    ],
  ])("restores a stored layout with %s", (_name, tabs, restored) => {
    const ids = Object.keys(tabs);
    const stored = {
      root: { kind: "pane", id: "p0", tabs: ["chat", ...ids], active: "chat" },
      tabs: { chat: { kind: "primary-chat" }, ...tabs },
      focused: "p0",
      seq: 1,
    };
    const layout = restoreWorkArea(stored);
    expect(layout !== null).toBe(restored);
    if (layout) expect(restoreWorkArea(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });

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

  it("a linked file's shown citation survives a reload; a new or reopened citation reveals again", () => {
    const fileTab = linkedFileTabId(other, "src/x.ts");
    const entryOf = (tab: TabId) => stripEntries(layout(), record(), [tab], ref, "Chat")[0];
    const payload = () => layout().tabs[fileTab];
    const link = () => change({ type: "link-file", source: other, path: "src/x.ts", line: 3 });
    link();
    const first = entryOf(fileTab);
    change({ type: "linked-file-shown", tab: fileTab, reveal: 1 });
    expect(payload()).toMatchObject({ reveal: 1, shown: true });
    expect(entryOf(fileTab)).toBe(first);

    const restored = restoreWorkArea(JSON.parse(JSON.stringify(layout())))?.tabs[fileTab];
    if (restored?.kind !== "linked-file") throw new Error("linked file not restored");
    expect(restored.shown).toBe(true);
    const reloaded = linkedFileEntry(fileTab, restored);
    expect(reloaded.revealLine).toBeNull();
    expect(reloaded.reveal.revealLine).toBeNull();

    const before = layout();
    change({ type: "linked-file-shown", tab: fileTab, reveal: 0 });
    expect(layout()).toBe(before);

    link();
    expect(payload()).toMatchObject({ reveal: 2 });
    expect(payload()).not.toHaveProperty("shown");
    expect(entryOf(fileTab)).toMatchObject({ revealLine: 3, revealRequestId: 2 });

    change({ type: "linked-file-shown", tab: fileTab, reveal: 2 });
    change({ type: "close", tab: fileTab });
    link();
    expect(payload()).toMatchObject({ reveal: 1 });
    expect(payload()).not.toHaveProperty("shown");
    expect(entryOf(fileTab)).toMatchObject({ revealLine: 3, revealRequestId: 1 });
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

  it("restores the other records when one stores a reply id it cannot encode", () => {
    const stored = (first: string, tab: string) => ({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
      workArea: {
        root: { kind: "pane", id: "p0", tabs: ["chat", tab], active: "chat" },
        tabs: {
          chat: { kind: "primary-chat" },
          [tab]: { kind: "sub-thread", thread: other, first },
        },
        focused: "p0",
        seq: 1,
      },
    });
    const validTab = replyTabId(other, "m-1");
    const merged = mergePersistedWorkArea(
      {
        byThreadKey: {
          [scopedThreadKey(ref)]: stored("\ud800", "reply:bad"),
          [scopedThreadKey(other)]: stored("m-1", validTab),
        },
      },
      useRightPanelStore.getInitialState(),
    );
    useRightPanelStore.setState({ byThreadKey: merged.byThreadKey });
    expect(shape()).toEqual(["chat"]);
    const neighbour = selectThreadRightPanelState(store().byThreadKey, other);
    expect(neighbour.workArea?.root).toMatchObject({ tabs: ["chat", validTab] });
  });
});
