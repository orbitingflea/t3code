import type { ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { revealThreadTerminal } from "~/lib/revealThreadTerminal";
import { hostRightPanel, selectThreadRightPanelState } from "~/rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";

import { adoptServerTerminals, followDrawerTerminals, terminalTabShown } from "./drawerTerminals";
import { dismissTerminalTabs } from "./terminalTabsSeen";
import { focusedTab, PRIMARY_CHAT, resolveLayout } from "./workArea.logic";
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

// One page life: fresh modules, so the stores load what the last page saved.
async function loadPage() {
  vi.resetModules();
  const terminalStore = await import("~/terminalUiStateStore");
  const panelStore = await import("~/rightPanelStore");
  const layout = await import("./workArea.logic");
  const drawer = await import("./drawerTerminals");
  const record = () =>
    panelStore.selectThreadRightPanelState(
      panelStore.useRightPanelStore.getState().byThreadKey,
      ref,
    );
  return {
    drawer,
    terminals: terminalStore.useTerminalUiStateStore.getState(),
    panels: () => panelStore.useRightPanelStore.getState(),
    record,
    focused: () => layout.focusedTab(layout.resolveLayout(record())),
    drawerOpen: () =>
      terminalStore.selectThreadTerminalUiState(
        terminalStore.useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        ref,
      ).terminalOpen,
    list: (sessionIds: string[]) =>
      drawer.adoptServerTerminals(ref, { sessionIds, surfaces: record().surfaces, suppressed: [] }),
  };
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

  it.each([
    ["shows the saved active terminal when nothing took focus", false, "terminal:t1"],
    ["keeps a file the user opened meanwhile in focus", true, "file:picked.ts"],
  ])(
    "converts a drawer saved open after a reload before its first session list, and %s",
    async (_, openFile, focused) => {
      const saved = new Map<string, string>();
      vi.stubGlobal("window", {
        localStorage: {
          getItem: (key: string) => saved.get(key) ?? null,
          setItem: (key: string, value: string) => void saved.set(key, value),
          removeItem: (key: string) => void saved.delete(key),
        },
      });
      try {
        const old = await loadPage();
        old.terminals.ensureTerminal(ref, "t1", { open: true });
        old.terminals.splitTerminalVertical(ref, "t2");
        old.terminals.setActiveTerminal(ref, "t2");
        const first = await loadPage();
        first.drawer.followDrawerTerminals();
        expect(first.drawerOpen()).toBe(false);
        if (openFile) first.panels().openFile(ref, "picked.ts");
        const second = await loadPage();
        second.drawer.followDrawerTerminals();
        expect(second.drawerOpen()).toBe(false);
        expect(second.record().surfaces.filter((s) => s.kind === "terminal")).toEqual([]);
        second.list(["t1", "t2"]);
        expect(second.record().surfaces.filter((s) => s.kind === "terminal")).toEqual([
          expect.objectContaining({
            id: "terminal:t1",
            terminalIds: ["t1", "t2"],
            splitDirection: "vertical",
          }),
        ]);
        expect(second.focused()).toBe(focused);
        const after = second.record();
        second.list(["t1", "t2"]);
        expect(second.record()).toBe(after);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    ["found open in both at once", true],
    ["found open in the second later", false],
  ])("converts a drawer once when two tabs of the app wait for it, %s", async (_, together) => {
    const saved = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => void saved.set(key, value),
        removeItem: (key: string) => void saved.delete(key),
      },
    });
    try {
      const old = await loadPage();
      old.terminals.ensureTerminal(ref, "t1", { open: true });
      old.terminals.splitTerminalVertical(ref, "t2");
      old.terminals.ensureTerminal(other, "u1", { open: true });
      const a = await loadPage();
      if (!together) a.drawer.followDrawerTerminals();
      const b = await loadPage();
      if (together) a.drawer.followDrawerTerminals();
      b.drawer.followDrawerTerminals();
      b.list(["t1", "t2"]);
      a.drawer.adoptServerTerminals(other, { sessionIds: ["u1"], surfaces: [], suppressed: [] });
      b.panels().updateWorkArea(ref, { type: "activate", tab: PRIMARY_CHAT });
      const reloaded = await loadPage();
      reloaded.drawer.followDrawerTerminals();
      const before = reloaded.record();
      reloaded.list(["t1", "t2"]);
      expect(reloaded.record()).toBe(before);
      expect(reloaded.focused()).toBe(PRIMARY_CHAT);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a file opened before a late first session list in focus", async () => {
    const page = await loadPage();
    page.terminals.ensureTerminal(ref, "t1", { open: true });
    page.terminals.splitTerminalVertical(ref, "t2");
    page.drawer.followDrawerTerminals();
    page.panels().openFile(ref, "picked.ts");
    page.list(["t1", "t2"]);
    expect(page.record().surfaces.filter((s) => s.kind === "terminal")).toEqual([
      expect.objectContaining({ id: "terminal:t1", terminalIds: ["t1", "t2"] }),
    ]);
    expect(page.record().activeSurfaceId).toBe("file:picked.ts");
    expect(page.focused()).toBe("file:picked.ts");
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
