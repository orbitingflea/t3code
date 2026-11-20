import { describe, expect, it } from "vite-plus/test";

import {
  type Box,
  type DragSubject,
  type DropPlan,
  inStripView,
  type PaneGeometry,
  planDrop,
} from "./dropPlan.logic";
import type { Edge, LayoutNode, PaneId, SplitId, TabId } from "./workArea.logic";

const box = (left: number, top: number, right: number, bottom: number): Box => ({
  left,
  top,
  right,
  bottom,
});

/** A pane whose 40 px strip holds 80 px tabs from its left edge. */
function pane(id: string, frame: Box, tabs: readonly string[]): PaneGeometry {
  return {
    id: id as PaneId,
    frame,
    strip: { ...frame, bottom: frame.top + 40 },
    tabs: tabs.map((tab, index) => ({
      id: tab as TabId,
      box: box(
        frame.left + index * 80,
        frame.top + 8,
        frame.left + (index + 1) * 80,
        frame.top + 32,
      ),
    })),
  };
}

const left = pane("p0", box(0, 0, 600, 600), ["chat", "diff"]);
const right = pane("p1", box(600, 0, 1200, 600), ["file:a"]);
const threads: DragSubject = { kind: "threads" };
const always = () => true;
const never = () => false;

describe("planDrop", () => {
  it("inserts before the tab under the pointer, or at the end of the strip", () => {
    expect(planDrop([left, right], { x: 50, y: 20 }, threads, always)).toEqual({
      at: { kind: "strip", pane: "p0", before: "diff" },
      ghost: { kind: "marker", left: 79, top: 8, height: 24 },
    });
    expect(planDrop([left, right], { x: 400, y: 20 }, threads, always)?.at).toEqual({
      kind: "strip",
      pane: "p0",
      before: null,
    });
  });

  it.each<[Edge, { x: number; y: number }, Box]>([
    ["left", { x: 610, y: 320 }, box(600, 0, 900, 600)],
    ["right", { x: 1190, y: 320 }, box(900, 0, 1200, 600)],
    ["top", { x: 900, y: 60 }, box(600, 0, 1200, 300)],
    ["bottom", { x: 900, y: 590 }, box(600, 300, 1200, 600)],
  ])("splits on the %s edge with a ghost of that half", (edge, point, ghost) => {
    expect(planDrop([left, right], point, threads, always)).toEqual({
      at: { kind: "edge", pane: "p1", edge },
      ghost: {
        kind: "box",
        left: ghost.left,
        top: ghost.top,
        width: ghost.right - ghost.left,
        height: ghost.bottom - ghost.top,
      },
    });
  });

  it("joins a pane from the centre of its body, and from an edge that cannot split", () => {
    const join = { kind: "join", pane: "p1" };
    expect(planDrop([left, right], { x: 900, y: 320 }, threads, always)?.at).toEqual(join);
    expect(planDrop([left, right], { x: 1190, y: 320 }, threads, never)?.at).toEqual(join);
  });

  it("refuses a lone tab on its own pane, and keeps a tab of a fuller pane splittable", () => {
    const lone: DragSubject = { kind: "tab", tab: "file:a" as TabId, from: "p1" as PaneId };
    expect(planDrop([left, right], { x: 1190, y: 320 }, lone, always)).toBeNull();
    expect(planDrop([left, right], { x: 900, y: 320 }, lone, always)).toBeNull();
    const diff: DragSubject = { kind: "tab", tab: "diff" as TabId, from: "p0" as PaneId };
    expect(planDrop([left, right], { x: 590, y: 320 }, diff, always)?.at).toEqual({
      kind: "edge",
      pane: "p0",
      edge: "right",
    });
    expect(planDrop([left, right], { x: 170, y: 20 }, diff, always)).toBeNull();
  });

  it("picks stacked panes by the pointer's height", () => {
    const top = pane("p0", box(0, 0, 600, 300), ["chat"]);
    const bottom = pane("p2", box(0, 300, 600, 600), ["diff"]);
    expect(planDrop([top, bottom], { x: 300, y: 450 }, threads, always)?.at).toEqual({
      kind: "join",
      pane: "p2",
    });
    expect(planDrop([top, bottom], { x: 300, y: 150 }, threads, always)?.at).toEqual({
      kind: "join",
      pane: "p0",
    });
  });
});

describe("inStripView", () => {
  const leaf = (id: string, tabs: readonly [string, ...string[]]): LayoutNode => ({
    kind: "pane",
    id: id as PaneId,
    tabs: tabs.map((tab) => tab as TabId) as [TabId, ...TabId[]],
    active: tabs[0] as TabId,
  });
  const root: LayoutNode = {
    kind: "split",
    id: "s1" as SplitId,
    axis: "row",
    ratio: 0.5,
    first: leaf("p0", ["chat", "file:a"]),
    second: leaf("p1", ["file:b", "file:c"]),
  };
  const strip = pane("p0", box(0, 0, 1200, 600), ["chat", "file:a", "file:b", "file:c"]);
  const fileA: DragSubject = { kind: "tab", tab: "file:a" as TabId, from: "p0" as PaneId };
  const into = (pane: string, before: string | null) => ({ kind: "strip", pane, before });

  it.each<[string, { x: number; y: number }, ReturnType<typeof into> | null]>([
    ["before a tab of another pane, into that pane", { x: 250, y: 20 }, into("p1", "file:c")],
    ["before a tab of its own pane", { x: 10, y: 20 }, into("p0", "chat")],
    ["at the end, into the last pane", { x: 1000, y: 20 }, into("p1", null)],
    ["where it already is, as none", { x: 170, y: 20 }, null],
    ["on the body, as none", { x: 600, y: 320 }, null],
  ])("drops a tab of the one strip %s", (_name, point, expected) => {
    expect(inStripView(planDrop([strip], point, fileA, never), root)?.at ?? null).toEqual(expected);
  });

  it("keeps drops that are not strip drops", () => {
    const join: DropPlan = {
      at: { kind: "join", pane: "p0" as PaneId },
      ghost: { kind: "box", left: 0, top: 0, width: 1, height: 1 },
    };
    expect(inStripView(join, root)).toBe(join);
    expect(inStripView(null, root)).toBeNull();
  });
});
