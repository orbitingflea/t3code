import type { ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { revealThreadTerminal } from "~/lib/revealThreadTerminal";
import { hostRightPanel, selectThreadRightPanelState } from "~/rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";

import { adoptServerTerminals, followDrawerTerminals, terminalTabShown } from "./drawerTerminals";
import { dismissTerminalTabs } from "./terminalTabsSeen";
import { focusedTab, resolveLayout } from "./workArea.logic";
import { other, ref, resetWorkAreaStore, store, WIDE } from "./workAreaTestKit";
import { publishWorkAreaView } from "./workAreaView";

const terminals = () => useTerminalUiStateStore.getState();
const drawerOpen = (thread: ScopedThreadRef) =>
  selectThreadTerminalUiState(terminals().terminalUiStateByThreadKey, thread).terminalOpen;
const recordOf = (thread: ScopedThreadRef) =>
  selectThreadRightPanelState(store().byThreadKey, thread);
const shownTab = (thread: ScopedThreadRef) => focusedTab(resolveLayout(recordOf(thread)));
const terminalTabs = (thread: ScopedThreadRef) =>
  recordOf(thread)
    .surfaces.filter((surface) => surface.kind === "terminal")
    .map((surface) => surface.id);
const activeTerminal = (thread: ScopedThreadRef) =>
  recordOf(thread).surfaces.find((surface) => surface.kind === "terminal")?.activeTerminalId;

function reset() {
  resetWorkAreaStore();
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
    serverObservationsByThreadKey: {},
  });
}

// The follower starts once per page, so the saved state it meets at start comes first here.
describe("the terminal drawer as a request for a terminal tab", () => {
  it("turns each group of a drawer saved open into a terminal tab of its listed members once, and leaves the drawer closed", () => {
    reset();
    terminals().ensureTerminal(ref, "t1", { open: true });
    terminals().splitTerminalVertical(ref, "t2");
    terminals().splitTerminalVertical(ref, "t5");
    terminals().newTerminal(ref, "t3");
    terminals().newTerminal(ref, "t4");
    terminals().setActiveTerminal(ref, "t2");
    // A tab that already holds a terminal keeps it.
    store().openTerminal(ref, "t4");
    expect(drawerOpen(ref)).toBe(true);
    followDrawerTerminals();
    expect(drawerOpen(ref)).toBe(false);
    expect(terminalTabs(ref)).toEqual(["terminal:t4"]);
    const list = () =>
      adoptServerTerminals(ref, {
        // Another client closed t5 before this session's first list.
        sessionIds: ["t1", "t2", "t3", "t4"],
        surfaces: recordOf(ref).surfaces,
        suppressed: [],
      });
    list();
    expect(recordOf(ref).surfaces).toEqual([
      expect.objectContaining({ id: "terminal:t4", terminalIds: ["t4"] }),
      expect.objectContaining({
        id: "terminal:t1",
        terminalIds: ["t1", "t2"],
        activeTerminalId: "t2",
        splitDirection: "vertical",
      }),
      expect.objectContaining({ id: "terminal:t3", terminalIds: ["t3"], activeTerminalId: "t3" }),
    ]);
    expect(recordOf(ref).activeSurfaceId).toBe("terminal:t1");
    expect(drawerOpen(ref)).toBe(false);
    const after = recordOf(ref);
    followDrawerTerminals();
    list();
    expect(recordOf(ref)).toBe(after);
  });

  it("opens a new script terminal as an active terminal tab", () => {
    reset();
    terminals().newTerminal(ref, "t2");
    expect(recordOf(ref).activeSurfaceId).toBe("terminal:t2");
    expect(drawerOpen(ref)).toBe(false);
  });

  it("shows the background tab that holds a reused terminal", () => {
    reset();
    store().openTerminal(ref, "t1");
    store().openFile(ref, "a.ts");
    terminals().ensureTerminal(ref, "t1", { open: true });
    expect(recordOf(ref).activeSurfaceId).toBe("terminal:t1");
    expect(terminalTabs(ref)).toEqual(["terminal:t1"]);
    expect(drawerOpen(ref)).toBe(false);
  });

  it.each<[string, () => void]>([
    ["a new terminal", () => {}],
    [
      "a terminal it already holds, while its host holds one with the same id",
      () => {
        store().openTerminal(other, "setup");
        store().openFile(other, "a.ts");
        store().openTerminal(ref, "setup");
        store().openFile(ref, "work.ts");
      },
    ],
    [
      "terminal that is the inactive member of its split terminal tab",
      () => {
        store().openTerminal(other, "setup");
        store().splitTerminal(other, "terminal:setup", "second");
        store().openFile(other, "a.ts");
      },
    ],
  ])("shows a hosted thread's revealed %s in its own record, never its host's", (_, arrange) => {
    reset();
    publishWorkAreaView(WIDE);
    arrange();
    const host = recordOf(ref);
    const unhost = hostRightPanel(other, ref);
    try {
      revealThreadTerminal(other, "setup");
      expect(terminalTabs(other)).toEqual(["terminal:setup"]);
      expect(recordOf(other).activeSurfaceId).toBe("terminal:setup");
      expect(shownTab(other)).toBe("terminal:setup");
      expect(activeTerminal(other)).toBe("setup");
      expect(recordOf(ref)).toBe(host);
      expect(drawerOpen(other)).toBe(false);
    } finally {
      unhost();
    }
  });
});

describe("a closed terminal tab", () => {
  it("stays closed when the session list loads after a close by a viewer who cannot stop it", () => {
    reset();
    // The saved tab of a shell still running; this viewer's close records no suppression.
    store().openTerminal(ref, "restored");
    dismissTerminalTabs(ref, ["restored"]);
    store().closeSurface(ref, "terminal:restored");
    adoptServerTerminals(ref, {
      sessionIds: ["restored"],
      surfaces: recordOf(ref).surfaces,
      suppressed: [],
    });
    expect(terminalTabs(ref)).toEqual([]);
  });
});

describe("terminalOpen in the shortcut context", () => {
  it("is true while a terminal tab is shown, as in the terminal itself, and false behind a file", () => {
    reset();
    publishWorkAreaView(WIDE);
    terminals().newTerminal(ref, "t1");
    expect(drawerOpen(ref)).toBe(false);
    expect(terminalTabShown(ref)).toBe(true);
    store().openFile(ref, "a.ts");
    expect(terminalTabShown(ref)).toBe(false);
    expect(terminalTabShown(null)).toBe(false);
  });

  it("is false for a thread shown as another thread's Chat tab, whose own tabs are not drawn", () => {
    reset();
    publishWorkAreaView(WIDE);
    store().openTerminal(other, "t1");
    expect(terminalTabShown(other)).toBe(true);
    const unhost = hostRightPanel(other, ref);
    try {
      expect(terminalTabShown(other)).toBe(false);
    } finally {
      unhost();
    }
  });
});
