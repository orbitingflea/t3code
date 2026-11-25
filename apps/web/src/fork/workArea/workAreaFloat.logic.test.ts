import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AuthSessionState, PreviewSessionSnapshot } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { followPreviewSessions, revealServerTabs } from "~/components/preview/agentOpenedPreviews";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { __testing as previewStateTesting } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import * as entities from "~/state/entities";
import * as session from "~/state/session";

import { holders, resolveLayout, type WorkAreaLayout } from "./workArea.logic";
import { togglePreview } from "./workAreaCommands";
import { primaryChatRect, shownSurfaces, type WorkAreaView } from "./workAreaGeometry.logic";
import { persistedRecord, restoredRecord } from "./workAreaStorage.logic";
import {
  change,
  fromChat,
  holderOf,
  layout,
  other,
  paneAt,
  panes,
  record,
  ref,
  resetWorkAreaStore,
  shape,
  store,
  tab,
  viewOf,
  WIDE,
} from "./workAreaTestKit";
import { publishWorkAreaView } from "./workAreaView";

const STRIP: WorkAreaView = { narrow: true, size: null };
const placedTabs = () => panes().flatMap((pane) => pane.tabs);
const surfaceIds = () => record().surfaces.map((surface) => surface.id);
const shownIds = (view: WorkAreaView = WIDE) =>
  shownSurfaces(record(), view).map((surface) => surface.id);
const floated = () => {
  const source = usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(ref)]?.source;
  return source?.kind === "browser" ? source.tabId : null;
};
// Simulates PreviewView's picture-in-picture button, which focuses its pane on press.
const pictureInPicture = (tabId: string) => {
  if (floated() === tabId) {
    usePreviewMiniPlayerStore.getState().close(ref);
    return;
  }
  const pane = holderOf(tab(`browser:${tabId}`));
  if (pane) change({ type: "focus", pane: pane.id });
  usePreviewMiniPlayerStore.getState().open(ref, { kind: "browser", tabId });
  store().close(ref);
};
const openInPanel = (tabId: string) => {
  usePreviewMiniPlayerStore.getState().close(ref);
  store().openBrowser(ref, tabId);
};
const settled = () => Promise.resolve();
// [left.ts, t2] | [t1, right.ts]: the browser t1 and right.ts in a pane of their own.
const t1BesideRight = () => {
  change({
    type: "place",
    source: { view: viewOf(tab("file:right.ts")) },
    at: { kind: "edge", pane: paneAt(1).id, edge: "right" },
  });
  change({
    type: "place",
    source: { view: viewOf(tab("browser:t1")) },
    at: { kind: "strip", pane: paneAt(2).id, before: tab("file:right.ts") },
  });
};
const previewGrant = () => vi.mocked(session.readEnvironmentScope);
const sessionState = Atom.make(AsyncResult.initial<AuthSessionState>());

beforeEach(() => {
  resetWorkAreaStore();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  vi.spyOn(session, "readEnvironmentScope").mockReturnValue(true);
  vi.spyOn(session.environmentSession, "sessionStateAtom").mockReturnValue(sessionState);
});

describe("a floating tab", () => {
  it.each([
    ["panes", WIDE],
    ["the strip view", STRIP],
  ] as const)(
    "is the browser the mini player plays when its pane's close comes, in %s",
    (_, view) => {
      publishWorkAreaView(view);
      store().open(ref, "diff");
      store().openBrowser(ref, "t1");
      pictureInPicture("t1");
      expect(placedTabs()).not.toContain("browser:t1");
      expect(surfaceIds()).toContain("browser:t1");
      expect(primaryChatRect(layout(), view)).not.toBeNull();
    },
  );

  it("never comes from a close while nothing plays, so a shown Diff stays in its pane", () => {
    publishWorkAreaView(WIDE);
    fromChat(() => store().open(ref, "diff"));
    store().close(ref);
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["diff"] });
    expect(resolveLayout(record()).floating).toBeUndefined();
    expect(record().isOpen).toBe(true);
  });

  it("never comes from a close while the mini player plays a tab no pane holds", () => {
    publishWorkAreaView(WIDE);
    fromChat(() => store().open(ref, "diff"));
    usePreviewMiniPlayerStore.getState().open(ref, { kind: "browser", tabId: "t9" });
    store().close(ref);
    expect(placedTabs()).toContain("diff");
    expect(resolveLayout(record()).floating).toBeUndefined();
  });

  it("returns to its own pane as a background tab when a second tab floats", async () => {
    publishWorkAreaView(WIDE);
    store().openFile(ref, "left.ts");
    store().openBrowser(ref, "t1");
    store().openBrowser(ref, "t2");
    store().openFile(ref, "right.ts");
    t1BesideRight();
    const home = holderOf(tab("browser:t1"))!.id;
    expect(holderOf(tab("browser:t2"))?.id).not.toBe(home);
    pictureInPicture("t1");
    pictureInPicture("t2");
    await settled();
    expect(floated()).toBe("t2");
    expect(holderOf(tab("browser:t1"))?.id).toBe(home);
    expect(placedTabs()).not.toContain("browser:t2");
    expect(shownIds()).not.toContain("browser:t1");
  });

  it("stays when an unfloat names another tab", () => {
    publishWorkAreaView(WIDE);
    store().openBrowser(ref, "t1");
    store().openBrowser(ref, "t2");
    pictureInPicture("t2");
    change({ type: "unfloat", tab: tab("browser:t1") });
    expect(resolveLayout(record()).floating?.tab).toBe("browser:t2");
  });

  it("returns to its pane when a tab covers the Chat that draws the mini player", async () => {
    publishWorkAreaView(STRIP);
    store().open(ref, "diff");
    store().openBrowser(ref, "t1");
    pictureInPicture("t1");
    change({ type: "activate", view: viewOf(tab("diff")) });
    await settled();
    expect(resolveLayout(record()).floating).toBeUndefined();
    expect(placedTabs()).toContain("browser:t1");
    expect(floated()).toBeNull();
  });

  it("returns to its pane when the window narrows to a strip that hides the Chat", async () => {
    publishWorkAreaView(WIDE);
    fromChat(() => store().open(ref, "diff"));
    store().openBrowser(ref, "t1");
    pictureInPicture("t1");
    expect(primaryChatRect(layout(), WIDE)).not.toBeNull();
    publishWorkAreaView(STRIP);
    await settled();
    expect(resolveLayout(record()).floating).toBeUndefined();
    expect(placedTabs()).toContain("browser:t1");
    expect(floated()).toBeNull();
  });

  it("returns to its pane when the client loses the preview grant its mini player needs", () => {
    publishWorkAreaView(WIDE);
    store().openBrowser(ref, "t1");
    togglePreview(ref);
    expect(floated()).toBe("t1");
    previewGrant().mockReturnValue(false);
    appAtomRegistry.set(sessionState, AsyncResult.initial(true));
    expect(resolveLayout(record()).floating).toBeUndefined();
    expect(placedTabs()).toContain("browser:t1");
    expect(floated()).toBeNull();
  });

  const reload = () => {
    const stored = JSON.parse(JSON.stringify(persistedRecord(record())));
    expect(stored.workArea?.floating).toBeUndefined();
    return resolveLayout(restoredRecord(stored));
  };
  it.each<[string, () => void, () => WorkAreaLayout]>([
    ["its mini player closes", () => pictureInPicture("t1"), layout],
    [
      "Preview: Toggle runs from another pane",
      () => (change({ type: "focus", pane: paneAt(0).id }), togglePreview(ref)),
      layout,
    ],
    ["the page reloads", () => {}, reload],
  ])("comes back to the pane it floated from when %s", async (_, exit, read) => {
    publishWorkAreaView(WIDE);
    store().openFile(ref, "left.ts");
    store().openBrowser(ref, "t1");
    store().openFile(ref, "right.ts");
    t1BesideRight();
    const home = holderOf(tab("browser:t1"))!.id;
    pictureInPicture("t1");
    expect(holderOf(tab("file:right.ts"))?.id).toBe(home);
    exit();
    await settled();
    expect(holders(read().root, tab("browser:t1"))[0]?.id).toBe(home);
  });

  it.each<[string, () => void]>([
    ["floated", () => togglePreview(ref)],
    ["behind another tab", () => store().open(ref, "diff")],
  ])(
    "shows a browser %s on a forced reveal without a user action, and the next PiP press floats it",
    (_, arrange) => {
      publishWorkAreaView(WIDE);
      store().openBrowser(ref, "t1");
      arrange();
      const revision = store().getUserActionRevision(ref);
      store().revealSurface(ref, "browser:t1");
      expect(shownIds()).toContain("browser:t1");
      expect(store().getUserActionRevision(ref)).toBe(revision);
      expect(floated()).toBeNull();
      pictureInPicture("t1");
      expect(floated()).toBe("t1");
      expect(placedTabs()).not.toContain("browser:t1");
    },
  );

  it("shows a forced reveal over the Chat of a one-pane strip", () => {
    publishWorkAreaView(STRIP);
    store().openBrowser(ref, "t1");
    change({ type: "activate", view: viewOf(tab("chat")) });
    store().revealSurface(ref, "browser:t1");
    expect(shownIds(STRIP)).toEqual(["browser:t1"]);
  });

  it.each<[string, () => void, readonly string[], string | null]>([
    ["floats over a drawn Chat", () => {}, [], "t1"],
    [
      "shows in a pane where no Chat is drawn to hold the mini player",
      () => {
        change({ type: "open-thread", thread: other });
        change({ type: "close", tab: tab("chat") });
        expect(primaryChatRect(layout(), WIDE)).toBeNull();
      },
      ["browser:t1"],
      null,
    ],
  ])("a new browser an agent reveals by force %s", (_, arrange, shown, floats) => {
    using _serverBrowser = vi
      .spyOn(entities, "readEnvironmentSupportsServerBrowser")
      .mockReturnValue(true);
    publishWorkAreaView(WIDE);
    arrange();
    const revision = store().getUserActionRevision(ref);
    const session: PreviewSessionSnapshot = {
      threadId: ref.threadId,
      tabId: "t1",
      navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
      runtime: "server",
      reveal: true,
      revealRequest: { id: "r1", force: true },
    };
    revealServerTabs(ref, [session], { autoShowFloatingPreview: false });
    followPreviewSessions(ref, {
      ...previewStateTesting.EMPTY_THREAD_PREVIEW_STATE,
      listLoaded: true,
      sessions: { t1: session },
    });
    expect(surfaceIds()).toEqual(["browser:t1"]);
    expect(shownIds()).toEqual(shown);
    expect(floated()).toBe(floats);
    expect(store().getUserActionRevision(ref)).toBe(revision);
  });
});

describe("preview.toggle", () => {
  it("floats the shown browser, docks it back, and leaves picture-in-picture working", () => {
    publishWorkAreaView(WIDE);
    store().openBrowser(ref, "t1");
    expect(togglePreview(ref)).toBe(true);
    expect(floated()).toBe("t1");
    expect(placedTabs()).not.toContain("browser:t1");
    expect(togglePreview(ref)).toBe(true);
    expect(floated()).toBeNull();
    expect(shownIds()).toEqual(["browser:t1"]);
    pictureInPicture("t1");
    expect(floated()).toBe("t1");
    expect(placedTabs()).not.toContain("browser:t1");
  });

  it("floats the focused pane's browser first, else the first drawn one, and docks it next", () => {
    publishWorkAreaView(WIDE);
    store().openBrowser(ref, "t1");
    store().openBrowser(ref, "t2");
    change({
      type: "place",
      source: { view: viewOf(tab("browser:t2")) },
      at: { kind: "edge", pane: panes()[1]!.id, edge: "right" },
    });
    change({ type: "focus", pane: panes()[0]!.id });
    togglePreview(ref);
    expect(floated()).toBe("t1");
    expect(placedTabs()).toContain("browser:t2");
    expect(togglePreview(ref)).toBe(true);
    expect(floated()).toBeNull();
    expect(placedTabs()).toEqual(expect.arrayContaining(["browser:t1", "browser:t2"]));
    expect(shownIds()).toContain("browser:t1");
  });

  it("leaves the browser in its pane for a client without the preview grant its mini player needs", () => {
    previewGrant().mockReturnValue(false);
    publishWorkAreaView(WIDE);
    store().openBrowser(ref, "t1");
    togglePreview(ref);
    expect(resolveLayout(record()).floating).toBeUndefined();
    expect(placedTabs()).toContain("browser:t1");
    expect(floated()).toBeNull();
  });

  it("draws the Chat in the strip view, so the mini player it holds shows", () => {
    publishWorkAreaView(STRIP);
    store().open(ref, "diff");
    store().openBrowser(ref, "t1");
    togglePreview(ref);
    expect(floated()).toBe("t1");
    expect(primaryChatRect(layout(), STRIP)).not.toBeNull();
  });
});

describe("the mini player's floating tab", () => {
  const device = { hostId: "host", deviceId: "phone", platform: "ios", name: "Phone" } as const;
  it.each<[string, () => void, string]>([
    [
      "a browser",
      () => {
        store().openBrowser(ref, "t1");
        togglePreview(ref);
      },
      "browser:t1",
    ],
    [
      "a device",
      () => {
        store().openDevice(ref, device);
        usePreviewMiniPlayerStore.getState().open(ref, { kind: "device", ...device });
        store().close(ref);
      },
      "device:host:phone",
    ],
  ])(
    "brings %s back as a background tab when its mini player closes, with no work area mounted",
    async (_, float, id) => {
      float();
      expect(placedTabs()).not.toContain(id);
      usePreviewMiniPlayerStore.getState().close(ref);
      await settled();
      expect(placedTabs()).toContain(id);
      publishWorkAreaView(WIDE);
      expect(shownIds()).toEqual([]);
    },
  );

  it("docks by the open's own rule from Open in panel", async () => {
    publishWorkAreaView(WIDE);
    store().openBrowser(ref, "t1");
    togglePreview(ref);
    openInPanel("t1");
    await settled();
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["browser:t1"] });
    expect(shownIds()).toEqual(["browser:t1"]);
  });
});
