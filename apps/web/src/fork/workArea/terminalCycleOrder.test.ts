import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { cycleThreadTerminal } from "~/lib/cycleThreadTerminal";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { asTabId, holders, resolveLayout } from "./workArea.logic";

it("cycles terminal tabs in the order their strip shows after a drag", () => {
  const ref = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("cycle-order"));
  useRightPanelStore.setState({ byThreadKey: {} });
  const panel = useRightPanelStore.getState();
  const state = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
  const open = (terminalId: string) => {
    panel.openTerminal(ref, terminalId);
    return asTabId(state().activeSurfaceId!);
  };
  const a = open("a");
  const b = open("b");
  const c = open("c");
  const pane = holders(resolveLayout(state()).root, a)[0]!;
  panel.updateWorkArea(ref, {
    type: "place",
    source: { view: { pane: pane.id, tab: c } },
    at: { kind: "strip", pane: pane.id, before: b },
  });
  panel.updateWorkArea(ref, { type: "activate", view: { pane: pane.id, tab: a } });
  expect(holders(resolveLayout(state()).root, a)[0]!.tabs.filter((tab) => tab !== "chat")).toEqual([
    a,
    c,
    b,
  ]);

  const activeTerminal = () => {
    const active = state().surfaces.find((surface) => surface.id === state().activeSurfaceId);
    return active?.kind === "terminal" ? active.activeTerminalId : null;
  };
  const visited = [true, true, true].map(() => {
    expect(cycleThreadTerminal(ref, "right-panel", "next")).toBe(true);
    return activeTerminal();
  });
  expect(visited).toEqual(["c", "b", "a"]);
});
