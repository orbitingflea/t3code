import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, RunId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useClosedViewStore } from "~/closedViewStore";
import { planNextReopen, reopenClosedView } from "~/reopenClosedView";
import {
  pullRequestSurface,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import { chatFileTarget } from "./chatFileOpener";
import { partitionOpenLinkedFiles } from "./closedLinkedFiles";
import { LINK_PROBE, probeLayout } from "./linkDrop.logic";
import { fileRowPanelLink, linkedTreeOwner } from "./linkSources";
import {
  focusedTab,
  linkedFileTabId,
  PRIMARY_CHAT,
  resolveLayout,
  secondaryChatTabId,
} from "./workArea.logic";
import { closeFocusedTab, runOpen, toggleDiff, togglePreview } from "./workAreaCommands";
import { fitsView, shownSurfaces } from "./workAreaGeometry.logic";
import { landingRect, type Placement } from "./workAreaPlacement.logic";
import {
  actives,
  change,
  chatBeside,
  layout,
  other,
  paneAt,
  ref,
  resetWorkAreaStore,
  shape,
  tab,
  WIDE,
} from "./workAreaTestKit";
import { publishWorkAreaView } from "./workAreaView";

// Right-panel store cases whose behavior diverges under the work area: proactive opens,
// `close` hiding no tab unless it floats, and ignoring `maximized`.

const store = () => useRightPanelStore.getState();
const recordOf = (thread: typeof ref) => selectThreadRightPanelState(store().byThreadKey, thread);
const shownKinds = (thread: typeof ref) =>
  shownSurfaces(recordOf(thread), WIDE).map((surface) => surface.kind);
const linkedPullRequest = pullRequestSurface({
  projectId: "project-a",
  repository: "pingdotgg/t3code",
  number: 42,
});

async function reloadRightPanelStore() {
  const { storage, name } = useRightPanelStore.persist.getOptions();
  const persisted = await storage!.getItem(name!);
  expect(persisted).not.toBeNull();
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  await storage!.setItem(name!, persisted!);
  await useRightPanelStore.persist.rehydrate();
}

beforeEach(resetWorkAreaStore);

describe("the right panel store in the work area", () => {
  it.each([
    {
      surface: linkedPullRequest,
      choose: () => store().openFile(ref, "notes.md"),
    },
    {
      surface: { id: "pull-requests", kind: "pull-requests" } as const,
      choose: () => store().openBrowser(ref, "tab-a"),
    },
  ])(
    "preserves the chosen tab when $surface.kind exists, and close hides no tab",
    ({ surface, choose }) => {
      store().openProactive(ref, surface, store().getUserActionRevision(ref));
      choose();
      const chosen = recordOf(ref);
      expect(store().openProactive(ref, surface, store().getUserActionRevision(ref))).toBe(false);
      expect(recordOf(ref)).toEqual(chosen);

      store().close(ref);
      expect(store().openProactive(ref, surface, store().getUserActionRevision(ref))).toBe(false);
      expect(resolveLayout(recordOf(ref))).toEqual(resolveLayout(chosen));
      expect(recordOf(ref).surfaces).toEqual(chosen.surfaces);
    },
  );

  it("retargets an existing PR tab but respects a later manual choice", () => {
    const relinkedPullRequest = pullRequestSurface({ ...linkedPullRequest, number: 43 });
    store().openPullRequest(ref, relinkedPullRequest);
    store().openPullRequest(ref, linkedPullRequest);
    const revision = store().getUserActionRevision(ref);

    expect(store().openProactive(ref, relinkedPullRequest, revision, true)).toBe(true);
    expect(selectActiveRightPanelSurface(store().byThreadKey, ref)).toEqual(relinkedPullRequest);

    store().close(ref);
    const closed = recordOf(ref);
    expect(resolveLayout(closed).floating).toBeUndefined();
    expect(store().openProactive(ref, linkedPullRequest, revision, true)).toBe(false);
    expect(recordOf(ref)).toBe(closed);
  });

  it("offers each completed diff once across dismissal, panel changes, and reload", async () => {
    publishWorkAreaView(WIDE);
    const offer = (turnId: string, thread = ref) =>
      store().openProactive(
        thread,
        { kind: "diff", turnId: RunId.make(turnId) },
        store().getUserActionRevision(thread),
      );
    expect(offer("turn-1")).toBe(true);
    expect(shownKinds(ref)).toEqual(["diff"]);

    store().closeSurface(ref, "diff");
    await reloadRightPanelStore();
    expect(offer("turn-1")).toBe(false);
    expect(shownKinds(ref)).toEqual([]);

    store().open(ref, "files");
    store().openFile(ref, "src/app.ts");
    await reloadRightPanelStore();
    expect(offer("turn-1")).toBe(false);
    expect(shownKinds(ref)).toEqual(["file"]);

    store().closeAllSurfaces(ref);
    await reloadRightPanelStore();
    expect(offer("turn-1")).toBe(false);
    expect(shownKinds(ref)).toEqual([]);

    const otherEnvironment = scopeThreadRef("env-2" as EnvironmentId, ref.threadId);
    for (const thread of [other, otherEnvironment]) {
      expect(offer("turn-1", thread)).toBe(true);
      expect(shownKinds(thread)).toEqual(["diff"]);
    }

    expect(offer("turn-2")).toBe(true);
    expect(shownKinds(ref)).toEqual(["diff"]);

    const existingDiff = recordOf(ref).surfaces.find((surface) => surface.kind === "diff");
    expect(offer("turn-3")).toBe(false);
    expect(recordOf(ref).surfaces.find((surface) => surface.kind === "diff")).toEqual(existingDiff);
    store().closeSurface(ref, "diff");
    await reloadRightPanelStore();
    expect(offer("turn-3")).toBe(false);
    expect(shownKinds(ref)).toEqual([]);

    // A later storage migration must preserve the dismissal, just like an ordinary reload.
    const { storage, name, version } = useRightPanelStore.persist.getOptions();
    const persisted = await storage!.getItem(name!);
    await storage!.setItem(name!, { ...persisted!, version: version! - 1 });
    await reloadRightPanelStore();
    expect(offer("turn-3")).toBe(false);
    expect(shownKinds(ref)).toEqual([]);

    expect(offer("turn-4")).toBe(true);
    expect(shownKinds(ref)).toEqual(["diff"]);
    store().closeSurface(ref, "diff");
    store().open(ref, "diff");
    expect(shownKinds(ref)).toEqual(["diff"]);
  });

  it("keeps no maximized flag and counts maximizing as no manual choice", () => {
    store().open(ref, "preview");
    const revision = store().getUserActionRevision(ref);
    store().setMaximized(ref, true);
    expect(recordOf(ref).maximized).toBeUndefined();
    expect(store().getUserActionRevision(ref)).toBe(revision);
  });
});

describe("single-feature toggles", () => {
  const closedIds = () =>
    useClosedViewStore
      .getState()
      .entries.flatMap((entry) => (entry.kind === "panel-tab" ? [entry.surface.id] : []));

  beforeEach(() => useClosedViewStore.setState({ entries: [] }));

  it("Diff toggle closes a shown Diff for Reopen Closed View, and opens it again", () => {
    publishWorkAreaView(WIDE);
    runOpen({ record: ref, tab: PRIMARY_CHAT }, () => store().open(ref, "diff"));
    toggleDiff(ref);
    expect(recordOf(ref).surfaces).toEqual([]);
    expect(closedIds()).toEqual(["diff"]);
    toggleDiff(ref);
    expect(shownKinds(ref)).toEqual(["diff"]);
  });

  it("Preview toggle closes an empty browser tab for Reopen Closed View", () => {
    publishWorkAreaView(WIDE);
    store().open(ref, "preview");
    expect(togglePreview(ref)).toBe(true);
    expect(recordOf(ref).surfaces).toEqual([]);
    expect(closedIds()).toEqual(["browser:new"]);
  });
});

describe("Reopen Closed Tab", () => {
  const notes = {
    type: "file" as const,
    id: "notes-1",
    name: "notes.md",
    mimeType: "text/plain",
    sizeBytes: 12,
  };

  beforeEach(() => useClosedViewStore.setState({ entries: [] }));

  // What the Reopen Closed Tab shortcut does before it restores an entry.
  const nextReopen = () => {
    const history = partitionOpenLinkedFiles(
      useClosedViewStore.getState().entries,
      store().byThreadKey,
    );
    const { drop, restore } = planNextReopen(history.closed, () => ({
      environmentKnown: true,
      catalogReady: true,
      ownerExists: true,
      sideChatExists: true,
      shellLive: true,
      panel: recordOf(ref),
    }));
    for (const entry of [...history.open, ...drop]) useClosedViewStore.getState().remove(entry.id);
    return restore;
  };

  it.each<[string, { path: string; line: number | null; attachment?: typeof notes }]>([
    ["a file at its line", { path: "src/current.ts", line: 12 }],
    ["an attachment", { path: "notes.md", line: null, attachment: notes }],
  ])("restores a linked file just closed, %s, in its source thread", async (_, linked) => {
    publishWorkAreaView(WIDE);
    store().openFile(ref, "older.ts");
    store().closeSurface(ref, "file:older.ts");
    change({ type: "link-file", source: other, ...linked });
    const target = linkedFileTabId(other, linked.path, linked.attachment?.id);
    expect(closeFocusedTab(ref, (surface) => store().closeSurface(ref, surface.id))).toBe(true);
    expect(layout().tabs[target]).toBeUndefined();
    // History persists as JSON, so the entry must survive a reload.
    const entries = JSON.parse(JSON.stringify(useClosedViewStore.getState().entries));
    useClosedViewStore.setState({ entries });

    const restore = nextReopen();
    if (restore === null) throw new Error("nothing to reopen");
    expect(restore.threadRef).toEqual(ref);
    expect(
      await reopenClosedView(restore, { openPreview: vi.fn(), workspaceAvailable: true }),
    ).toBe(true);
    useClosedViewStore.getState().remove(restore.id);
    expect(layout().tabs[target]).toMatchObject({ kind: "linked-file", source: other, ...linked });
    expect(focusedTab(layout())).toBe(target);

    // Closed again, then opened again by hand: the next reopen skips it, as it does a regular tab.
    expect(closeFocusedTab(ref, (surface) => store().closeSurface(ref, surface.id))).toBe(true);
    change({ type: "link-file", source: other, ...linked });
    expect(nextReopen()).toMatchObject({ kind: "panel-tab", surface: { id: "file:older.ts" } });
    expect(useClosedViewStore.getState().entries).toHaveLength(1);
  });
});

describe("a link dropped on a pane", () => {
  const drop = <T>(at: () => Placement, open: () => T, live = () => true): T =>
    runOpen({ record: ref, drop: { at: at(), live } }, open);
  const rightOf = (index: number) => (): Placement => ({
    kind: "edge",
    pane: paneAt(index).id,
    edge: "right",
  });

  beforeEach(() => publishWorkAreaView(WIDE));

  it("opens its file in a new pane at the edge it was dropped on", () => {
    chatBeside("a.ts");
    drop(rightOf(1), () => store().openFile(ref, "b.ts"));
    expect(shape()).toEqual({
      axis: "row",
      first: ["chat"],
      second: { axis: "row", first: ["file:a.ts"], second: ["file:b.ts"] },
    });
    expect(actives()).toEqual(["chat", "file:a.ts", "file:b.ts"]);
  });

  it("moves a file already open in another pane to the strip slot it was dropped on", () => {
    chatBeside("a.ts", "b.ts");
    drop(
      () => ({ kind: "strip", pane: paneAt(0).id, before: PRIMARY_CHAT }),
      () => store().openFile(ref, "a.ts"),
    );
    expect(shape()).toEqual({ axis: "row", first: ["file:a.ts", "chat"], second: ["file:b.ts"] });
  });

  it("moves the file its pane already shows", () => {
    chatBeside("a.ts");
    drop(
      () => ({ kind: "strip", pane: paneAt(0).id, before: null }),
      () => store().openFile(ref, "a.ts"),
    );
    expect(shape()).toEqual(["chat", "file:a.ts"]);
  });

  it("keeps a file dropped on the strip slot just before its own tab where it is", () => {
    chatBeside("a.ts", "b.ts");
    drop(
      () => ({ kind: "strip", pane: paneAt(1).id, before: tab("file:a.ts") }),
      () => store().openFile(ref, "a.ts"),
    );
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["file:a.ts", "file:b.ts"] });
  });

  it("lands a guest chat's linked file at the drop, not beside the guest", () => {
    change({
      type: "place",
      source: { threads: [other] },
      at: { kind: "edge", pane: paneAt(0).id, edge: "right" },
    });
    const guest = chatFileTarget(
      { kind: "shown", owner: ref, tab: secondaryChatTabId(other) },
      other,
    );
    drop(
      () => ({ kind: "edge", pane: paneAt(1).id, edge: "bottom" }),
      () => guest.openFile("x.ts"),
    );
    expect(shape()).toEqual({
      axis: "row",
      first: ["chat"],
      second: {
        axis: "column",
        first: [secondaryChatTabId(other)],
        second: [linkedFileTabId(other, "x.ts")],
      },
    });
  });

  it("opens a row dragged from a linked file's Files tree as that thread's file, at the drop", () => {
    chatBeside("a.ts");
    const row = fileRowPanelLink({
      owner: linkedTreeOwner(ref, other),
      treePath: "src/config.ts",
      isFile: () => true,
      panelPath: (path) => path,
    });
    expect(row?.panelRef).toEqual(ref);
    drop(rightOf(1), () => row?.open());
    expect(shape()).toEqual({
      axis: "row",
      first: ["chat"],
      second: {
        axis: "row",
        first: ["file:a.ts"],
        second: [linkedFileTabId(other, "src/config.ts")],
      },
    });
  });

  it("lands at the drop when the chat opens after an await", async () => {
    chatBeside("a.ts");
    const target = drop(rightOf(1), () => chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, ref));
    await Promise.resolve();
    target.openFile("b.ts");
    expect(shape()).toEqual({
      axis: "row",
      first: ["chat"],
      second: { axis: "row", first: ["file:a.ts"], second: ["file:b.ts"] },
    });
  });

  describe("on a pane too narrow for a Chat", () => {
    // [chat] | [a.ts], the file's pane 300 px wide: a file fits there, a Chat's message box not.
    const narrowFilePane = () => {
      chatBeside("a.ts");
      const split = layout().root;
      if (split.kind !== "split") throw new Error("expected two panes");
      change({ type: "ratio", split: split.id, ratio: 0.75 });
      expect(paneAt(1).tabs).toEqual(["file:a.ts"]);
    };
    const openThreadLink = () =>
      chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, ref).openThread(other);
    const onStrip = (): Placement => ({ kind: "strip", pane: paneAt(1).id, before: null });
    const inMiddle = (): Placement => ({ kind: "join", pane: paneAt(1).id });

    it.each([
      ["strip", onStrip],
      ["middle", inMiddle],
    ])("plans no drop of a thread link on its %s, but a file link's", (_, at) => {
      narrowFilePane();
      const plans = (link: { readonly opensChat?: boolean }) =>
        landingRect(
          probeLayout(layout(), ref, link),
          { type: "place", source: { tabs: [LINK_PROBE] }, at: at() },
          ref,
          WIDE,
        );
      expect(plans({ opensChat: true })).toBeNull();
      expect(plans({})).not.toBeNull();
    });

    it.each([
      ["strip", onStrip],
      ["middle", inMiddle],
    ])(
      "opens a thread link dropped on its %s where its click would, keeping the panes",
      (_, at) => {
        narrowFilePane();
        openThreadLink();
        const clicked = shape();
        resetWorkAreaStore();
        publishWorkAreaView(WIDE);
        narrowFilePane();
        drop(at, openThreadLink);
        expect(shape()).toEqual(clicked);
        expect(fitsView(layout(), WIDE)).toBe(true);
      },
    );
  });

  it.each<[string, () => boolean, () => Placement]>([
    ["cancelled by a later press", () => false, rightOf(1)],
    ["on a pane closed meanwhile", () => true, () => ({ kind: "join", pane: "p99" as never })],
  ])("opens where its click would when %s", (_, live, at) => {
    chatBeside("a.ts");
    drop(at, () => chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, ref).openFile("b.ts"), live);
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["file:a.ts", "file:b.ts"] });
  });
});
