import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  type RightPanelSurface,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import { asPaneId, leaves, type WorkAreaLayout } from "./workArea.logic";
import { restoredRecord } from "./workAreaStorage.logic";
import { change, layout, ref, resetWorkAreaStore, tab } from "./workAreaTestKit";
import { publishWorkAreaView } from "./workAreaView";

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
const row = (first: Node, second: Node): Node => ({
  kind: "split",
  id: "s1",
  axis: "row",
  ratio: 0.5,
  first,
  second,
});
const file = (path: string): RightPanelSurface => ({
  id: `file:${path}`,
  kind: "file",
  relativePath: path,
  revealLine: null,
  revealRequestId: 0,
});

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
    [...placed].map((id) => [id, id === "chat" ? { kind: "primary-chat" } : { kind: "surface" }]),
  );
  const restored = restoredRecord({
    isOpen: true,
    activeSurfaceId: null,
    surfaces,
    workArea: { root, tabs, focused, seq: 30 },
  } as unknown as ThreadRightPanelState);
  useRightPanelStore.setState({ byThreadKey: { [scopedThreadKey(ref)]: restored } });
}

const panesOf = (current: WorkAreaLayout = layout()) =>
  leaves(current.root).map((node) => ({ id: node.id, tabs: node.tabs, active: node.active }));

beforeEach(() => {
  resetWorkAreaStore();
  publishWorkAreaView({ narrow: false, size: { width: 1600, height: 900 } });
});

describe("a strip drag onto another pane's edge", () => {
  // p0 showed a.ts; the press on x.ts activated x.ts there, so the drop restores a.ts in p0.
  // p1 holds its own view of a.ts but shows b.ts.
  const drag = () =>
    change({
      type: "place",
      source: {
        view: { pane: asPaneId("p0"), tab: tab("file:x.ts") },
        restore: tab("file:a.ts"),
      },
      at: { kind: "edge", pane: asPaneId("p1"), edge: "bottom" },
    });

  it("leaves the target pane on the tab it showed (target also holds the restored tab)", () => {
    seat(
      [file("a.ts"), file("b.ts"), file("x.ts")],
      row(
        pane("p0", ["chat", "file:a.ts", "file:x.ts"], "file:x.ts"),
        pane("p1", ["file:a.ts", "file:b.ts"], "file:b.ts"),
      ),
    );
    drag();
    const p1 = panesOf().find((node) => node.id === "p1")!;
    expect(panesOf().find((node) => node.id === "p0")!.active).toBe("file:a.ts");
    expect(p1.active).toBe("file:b.ts");
  });

  it("leaves the target pane on the tab it showed (target without the restored tab)", () => {
    seat(
      [file("a.ts"), file("b.ts"), file("c.ts"), file("x.ts")],
      row(
        pane("p0", ["chat", "file:a.ts", "file:x.ts"], "file:x.ts"),
        pane("p1", ["file:c.ts", "file:b.ts"], "file:b.ts"),
      ),
    );
    drag();
    expect(panesOf().find((node) => node.id === "p1")!.active).toBe("file:b.ts");
  });
});

describe("a strip drag in the one strip", () => {
  it("restores only the pressed view's pane; another pane keeps the tab it showed", () => {
    seat(
      [file("a.ts"), file("b.ts"), file("x.ts")],
      row(
        pane("p0", ["chat", "file:a.ts", "file:x.ts"], "file:x.ts"),
        pane("p1", ["file:a.ts", "file:x.ts", "file:b.ts"], "file:b.ts"),
      ),
    );
    publishWorkAreaView({ narrow: true, size: null });
    // The one strip's press on x.ts (p0 showed a.ts), dropped before the Chat.
    change({
      type: "place",
      source: { view: { pane: asPaneId("p0"), tab: tab("file:x.ts") }, restore: tab("file:a.ts") },
      at: { kind: "strip", pane: asPaneId("p0"), before: tab("chat") },
    });
    expect(panesOf().find((node) => node.id === "p1")!.active).toBe("file:b.ts");
  });
});
