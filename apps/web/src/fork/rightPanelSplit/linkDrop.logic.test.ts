import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type RightPanelSurface,
  selectThreadRightPanelState,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import type { Rect } from "./dropTarget.logic";
import {
  dropEffectFor,
  type LinkDropInput,
  type LinkPlacement,
  type PaneGeometry,
  placementChange,
  planLinkDrop,
} from "./linkDrop.logic";
import { applySplitChange, paneLayout, type PanelArrangement } from "./splitLayout.logic";

const file = (name: string): RightPanelSurface => ({
  id: `file:${name}`,
  kind: "file",
  relativePath: name,
  revealLine: null,
  revealRequestId: 1,
});
const id = (name: string) => file(name).id;

const box = (left: number, top: number, right: number, bottom: number): Rect => ({
  left,
  top,
  right,
  bottom,
});
const tab = (name: string, left: number) => ({ id: id(name), rect: box(left, 4, left + 80, 28) });

const flat: PanelArrangement = { surfaces: ["a", "b", "c"].map(file), activeSurfaceId: id("b") };
const twoPanes: PanelArrangement = {
  surfaces: ["a", "b", "c", "d"].map(file),
  activeSurfaceId: id("a"),
  split: { rightIds: [id("c"), id("d")], otherShownId: id("c"), ratio: 0.5 },
};

const single = (tabs: PaneGeometry["tabs"]): PaneGeometry => ({
  side: "left",
  strip: box(0, 0, 600, 32),
  content: box(0, 32, 600, 432),
  tabs,
});
const flatPane = single([tab("a", 10), tab("b", 100), tab("c", 190)]);
const leftPane: PaneGeometry = {
  side: "left",
  strip: box(0, 0, 300, 32),
  content: box(0, 32, 300, 432),
  tabs: [tab("a", 10), tab("b", 100)],
};
const rightPane: PaneGeometry = {
  side: "right",
  strip: box(301, 0, 600, 32),
  content: box(301, 32, 600, 432),
  tabs: [tab("c", 311), tab("d", 401)],
};

function plan(input: Partial<LinkDropInput> & Pick<LinkDropInput, "pointer">) {
  return planLinkDrop({
    arrangement: flat,
    splitRendered: false,
    splitAllowed: true,
    splitGrowth: 0,
    panes: [flatPane],
    ...input,
  });
}

const marker = (left: number) => ({ kind: "marker", left: left - 1, top: 4, height: 24 });

describe("planLinkDrop", () => {
  it.each<[string, Partial<LinkDropInput> & Pick<LinkDropInput, "pointer">, unknown]>([
    [
      "the left half of a tab: before it",
      { pointer: { x: 110, y: 16 } },
      { placement: { kind: "slot", pane: "left", beforeId: id("b") }, ghost: marker(100) },
    ],
    [
      "the right half of a tab: before its successor",
      { pointer: { x: 170, y: 16 } },
      { placement: { kind: "slot", pane: "left", beforeId: id("c") }, ghost: marker(180) },
    ],
    [
      "strip space past the last tab: the end",
      { pointer: { x: 500, y: 2 } },
      { placement: { kind: "slot", pane: "left", beforeId: null }, ghost: marker(270) },
    ],
    [
      "a successor scrolled out of view still names the slot",
      { pointer: { x: 170, y: 16 }, panes: [single([tab("a", 10), tab("b", 100)])] },
      { placement: { kind: "slot", pane: "left", beforeId: id("c") }, ghost: marker(180) },
    ],
    [
      "only visible tabs pick the slot",
      { pointer: { x: 5, y: 16 }, panes: [single([tab("b", 100), tab("c", 190)])] },
      { placement: { kind: "slot", pane: "left", beforeId: id("b") }, ghost: marker(100) },
    ],
    [
      "an empty strip: the end",
      {
        pointer: { x: 300, y: 16 },
        arrangement: { surfaces: [], activeSurfaceId: null },
        panes: [single([])],
      },
      {
        placement: { kind: "slot", pane: "left", beforeId: null },
        ghost: { kind: "marker", left: 7, top: 0, height: 32 },
      },
    ],
    [
      "the right third of one pane: a split",
      { pointer: { x: 500, y: 200 } },
      {
        placement: { kind: "split", side: "right" },
        ghost: { kind: "box", left: 300, top: 32, width: 300, height: 400 },
      },
    ],
    [
      "the left third, on a panel that will widen",
      { pointer: { x: 100, y: 200 }, splitGrowth: 200 },
      {
        placement: { kind: "split", side: "left" },
        ghost: { kind: "box", left: -200, top: 32, width: 400, height: 400 },
      },
    ],
    [
      "the centre third: just open",
      { pointer: { x: 300, y: 200 } },
      {
        placement: { kind: "open" },
        ghost: { kind: "box", left: 0, top: 32, width: 600, height: 400 },
      },
    ],
    [
      "an outer third where a split is not allowed: just open",
      { pointer: { x: 500, y: 200 }, splitAllowed: false },
      {
        placement: { kind: "open" },
        ghost: { kind: "box", left: 0, top: 32, width: 600, height: 400 },
      },
    ],
    [
      "an outer third of an empty panel: just open",
      { pointer: { x: 500, y: 200 }, arrangement: { surfaces: [], activeSurfaceId: null } },
      {
        placement: { kind: "open" },
        ghost: { kind: "box", left: 0, top: 32, width: 600, height: 400 },
      },
    ],
    [
      "a shown split's other content: that pane",
      {
        pointer: { x: 500, y: 200 },
        arrangement: twoPanes,
        splitRendered: true,
        panes: [leftPane, rightPane],
      },
      {
        placement: { kind: "pane", pane: "right" },
        ghost: { kind: "box", left: 301, top: 32, width: 299, height: 400 },
      },
    ],
    [
      "a shown split's strip: a slot in that pane",
      {
        pointer: { x: 470, y: 16 },
        arrangement: twoPanes,
        splitRendered: true,
        panes: [leftPane, rightPane],
      },
      { placement: { kind: "slot", pane: "right", beforeId: null }, ghost: marker(481) },
    ],
  ])("%s", (_case, input, expected) => {
    expect(plan(input)).toEqual(expected);
  });

  describe("a stored split the panel is too narrow to show", () => {
    const hidden = {
      arrangement: twoPanes,
      panes: [single([tab("a", 10), tab("b", 100), tab("c", 190), tab("d", 280)])],
    };
    it.each<[string, { x: number; y: number }, LinkPlacement]>([
      ["after the left pane's last tab", { x: 170, y: 16 }, slot("left", id("c"))],
      ["before the right pane's first tab", { x: 200, y: 16 }, slot("right", id("c"))],
      ["past the last tab", { x: 500, y: 16 }, slot("right", null)],
      ["content, even an outer third", { x: 550, y: 200 }, { kind: "open" }],
    ])("%s", (_case, pointer, placement) => {
      expect(plan({ ...hidden, pointer })?.placement).toEqual(placement);
    });
  });

  it("is null off every pane", () => {
    expect(plan({ pointer: { x: 700, y: 200 } })).toBeNull();
    expect(plan({ pointer: { x: 300, y: 500 } })).toBeNull();
  });
});

function slot(pane: "left" | "right", beforeId: string | null): LinkPlacement {
  return { kind: "slot", pane, beforeId };
}

const flatWithE: PanelArrangement = {
  surfaces: ["a", "b", "c", "e"].map(file),
  activeSurfaceId: id("e"),
};
// A new surface lands in the focused pane: the left one.
const twoPanesWithE: PanelArrangement = {
  surfaces: ["a", "b", "e", "c", "d"].map(file),
  activeSurfaceId: id("e"),
  split: { rightIds: [id("c"), id("d")], otherShownId: id("c"), ratio: 0.5 },
};

describe("placementChange", () => {
  it.each<[string, PanelArrangement, PanelArrangement, string, LinkPlacement, unknown]>([
    [
      "a new surface splits off, the pane keeping what it showed",
      flat,
      flatWithE,
      id("e"),
      { kind: "split", side: "right" },
      { type: "split", surfaceId: id("e"), side: "right", restoreShown: id("b") },
    ],
    [
      "an existing surface splits off",
      flat,
      { ...flat, activeSurfaceId: id("c") },
      id("c"),
      { kind: "split", side: "left" },
      { type: "split", surfaceId: id("c"), side: "left", restoreShown: id("b") },
    ],
    [
      "a split that appeared meanwhile takes it on that side",
      flat,
      twoPanesWithE,
      id("e"),
      { kind: "split", side: "right" },
      { type: "move", surfaceId: id("e"), pane: "right", beforeId: null, restoreShown: id("b") },
    ],
    [
      "one strip: a slot reorders",
      flat,
      flatWithE,
      id("e"),
      slot("left", id("b")),
      { type: "reorder", surfaceId: id("e"), beforeId: id("b") },
    ],
    [
      "a tab dropped on its own slot stays",
      flat,
      { ...flat, activeSurfaceId: id("b") },
      id("b"),
      slot("left", id("b")),
      null,
    ],
    [
      "a slot in the other pane moves it there",
      twoPanes,
      twoPanesWithE,
      id("e"),
      slot("right", id("d")),
      { type: "move", surfaceId: id("e"), pane: "right", beforeId: id("d"), restoreShown: id("a") },
    ],
    [
      "a slot in a hidden split's other stored pane moves it there",
      twoPanes,
      twoPanesWithE,
      id("e"),
      slot("right", null),
      { type: "move", surfaceId: id("e"), pane: "right", beforeId: null, restoreShown: id("a") },
    ],
    [
      "the other pane's content takes it at its end",
      twoPanes,
      twoPanesWithE,
      id("e"),
      { kind: "pane", pane: "right" },
      { type: "move", surfaceId: id("e"), pane: "right", beforeId: null, restoreShown: id("a") },
    ],
    [
      "the pane it opened in keeps it",
      twoPanes,
      twoPanesWithE,
      id("e"),
      { kind: "pane", pane: "left" },
      null,
    ],
    [
      "an existing tab of the other pane moves, that pane keeping what it showed",
      twoPanes,
      {
        ...twoPanes,
        activeSurfaceId: id("d"),
        split: { ...twoPanes.split!, otherShownId: id("a") },
      },
      id("d"),
      { kind: "pane", pane: "left" },
      { type: "move", surfaceId: id("d"), pane: "left", beforeId: null, restoreShown: id("c") },
    ],
    ["just open", flat, flatWithE, id("e"), { kind: "open" }, null],
    ["a surface the state no longer has", flat, flat, id("e"), slot("left", null), null],
  ])("%s", (_case, before, after, surfaceId, placement, expected) => {
    expect(placementChange(before, after, surfaceId, placement)).toEqual(expected);
  });

  it("never changes what the other pane shows", () => {
    const change = placementChange(twoPanes, twoPanesWithE, id("e"), {
      kind: "pane",
      pane: "right",
    });
    const layout = paneLayout(applySplitChange(twoPanesWithE, change!));
    expect(layout.kind === "split" && [layout.left.shown.id, layout.right.shown.id]).toEqual([
      id("a"),
      id("e"),
    ]);
  });

  it.each([
    ["the file's pane is focused", id("a")],
    ["the explorer's pane is focused", "files"],
  ])(
    "a file dropped beside a pane holding only the Files explorer keeps that pane: %s",
    (_case, activeSurfaceId) => {
      const ref = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
      const before: ThreadRightPanelState = {
        isOpen: true,
        activeSurfaceId,
        surfaces: [file("a"), { id: "files", kind: "files" }],
        split: {
          rightIds: ["files"],
          otherShownId: activeSurfaceId === "files" ? id("a") : "files",
          ratio: 0.5,
        },
      };
      useRightPanelStore.setState({
        byThreadKey: { [scopedThreadKey(ref)]: before },
        userActionRevisionByThreadKey: {},
      });
      const store = useRightPanelStore.getState();
      const thread = () =>
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

      store.openFile(ref, "e", undefined, { keepExplorer: true });
      const change = placementChange(before, thread(), id("e"), { kind: "pane", pane: "left" });
      if (change !== null) store.updateSplit(ref, change);

      const layout = paneLayout(thread());
      expect(layout.kind === "split" && [layout.left.shown.id, layout.right.shown.id]).toEqual([
        id("e"),
        "files",
      ]);
    },
  );
});

describe("dropEffectFor", () => {
  it.each([
    ["all", "copy"],
    ["uninitialized", "copy"],
    ["copyMove", "copy"],
    ["copyLink", "copy"],
    ["linkMove", "link"],
    ["link", "link"],
    ["move", "move"],
    ["none", null],
  ])("%s gives %s", (effectAllowed, effect) => {
    expect(dropEffectFor(effectAllowed)).toBe(effect);
  });
});
