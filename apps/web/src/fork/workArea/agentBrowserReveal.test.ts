import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { startAgentOpenedPreviews } from "~/components/preview/agentOpenedPreviews";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import {
  applyPreviewServerEvent,
  applyPreviewServerSnapshot,
  beginPreviewSessionClose,
  cancelPreviewSessionClose,
  reconcilePreviewServerSessions,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { revealServerTabs } from "./agentBrowserReveal";
import { shownSurfaces } from "./workAreaGeometry.logic";
import { publishWorkAreaView } from "./workAreaView";

vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => true,
}));

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));
const threadKey = scopedThreadKey(ref);
const WIDE = { narrow: false, size: { width: 1200, height: 800 } };
const serverEpoch = "server-a";

const serverTab = (overrides: Partial<PreviewSessionSnapshot> = {}): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab_a",
  navStatus: { _tag: "Loading", url: "http://localhost:5173/", title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  runtime: "server",
  reveal: true,
  ...overrides,
});

function setup(): Disposable {
  resetPreviewStateForTests();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  return { [Symbol.dispose]: publishWorkAreaView(WIDE) };
}

function following(): Disposable {
  const view = setup();
  const stop = startAgentOpenedPreviews();
  return {
    [Symbol.dispose]: () => {
      stop();
      view[Symbol.dispose]();
    },
  };
}

const shown = () => {
  const record = useRightPanelStore.getState().byThreadKey[threadKey];
  return record ? shownSurfaces(record, WIDE).map((surface) => surface.id) : [];
};
const browserTabs = (threadKeyToRead = threadKey) =>
  useRightPanelStore
    .getState()
    .byThreadKey[threadKeyToRead]?.surfaces.filter((surface) => surface.kind === "preview")
    .map((surface) => surface.id) ?? [];
const miniPlayerSource = () => usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source;

const opened = (threadRef: ScopedThreadRef, snapshot: PreviewSessionSnapshot, revision: number) =>
  applyPreviewServerEvent(threadRef, {
    type: "opened",
    threadId: snapshot.threadId,
    tabId: snapshot.tabId,
    createdAt: snapshot.updatedAt,
    snapshot,
    serverEpoch,
    revision,
  });
const navigated = (revision: number, snapshot: PreviewSessionSnapshot) =>
  applyPreviewServerEvent(ref, {
    type: "navigated",
    threadId: "thread-1",
    tabId: snapshot.tabId,
    createdAt: snapshot.updatedAt,
    snapshot,
    serverEpoch,
    revision,
  });

describe("revealServerTabs", () => {
  it.each([
    ["keeps a plain reveal out of view with the setting off", false, false, []],
    ["shows a forced reveal with the setting off", false, true, ["browser:tab_a"]],
    ["shows a plain reveal with the setting on", true, false, ["browser:tab_a"]],
  ] as const)("%s, as a tab and never floating", (_, autoShowFloatingPreview, force, expected) => {
    using _view = setup();
    const tab = serverTab(force ? { revealRequest: { id: "r1", force } } : {});
    revealServerTabs(ref, [tab], { autoShowFloatingPreview });
    expect(shown()).toEqual(expected);
    expect(miniPlayerSource()).toBeUndefined();
  });

  it("shows a tab already in the work area without a user action", () => {
    using _view = setup();
    useRightPanelStore.getState().openBrowser(ref, "tab_a");
    useRightPanelStore.getState().open(ref, "diff");
    expect(shown()).toEqual(["diff"]);
    const userActionRevision = useRightPanelStore.getState().getUserActionRevision(ref);
    revealServerTabs(ref, [serverTab()], { autoShowFloatingPreview: true });
    expect(shown()).toEqual(["browser:tab_a"]);
    // A user action moves keyboard focus into the panel; an agent reveal must not.
    expect(useRightPanelStore.getState().getUserActionRevision(ref)).toBe(userActionRevision);
  });
});

describe("agent browser reveals in the work area", () => {
  it("treats the first list as a baseline and shows a tab an agent opens later", () => {
    using _following = following();
    reconcilePreviewServerSessions(ref, {
      sessions: [serverTab({ tabId: "tab_restored" })],
      serverEpoch,
      revision: 1,
    });
    expect(browserTabs()).toEqual(["browser:tab_restored"]);
    expect(shown()).toEqual([]);

    opened(ref, serverTab({ tabId: "tab_agent" }), 2);
    expect(shown()).toEqual(["browser:tab_agent"]);
    expect(miniPlayerSource()).toBeUndefined();
  });

  it("reveals an existing tab only for a new reveal request", () => {
    using _following = following();
    const tab = serverTab({ revealRequest: { id: "r1", force: false } });
    reconcilePreviewServerSessions(ref, { sessions: [tab], serverEpoch, revision: 1 });

    navigated(2, { ...tab, updatedAt: "2026-01-01T00:00:01.000Z" });
    expect(shown()).toEqual([]);

    navigated(3, {
      ...tab,
      revealRequest: { id: "r2", force: true },
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(shown()).toEqual(["browser:tab_a"]);
  });

  it("never reveals tabs this client opened, desktop tabs, or a tab whose close failed", () => {
    using _following = following();
    const tab = serverTab({ tabId: "tab_closing" });
    reconcilePreviewServerSessions(ref, { sessions: [tab], serverEpoch, revision: 1 });
    applyPreviewServerSnapshot(ref, serverTab({ tabId: "tab_own", reveal: undefined }));
    applyPreviewServerSnapshot(ref, { ...serverTab({ tabId: "tab_desktop" }), runtime: "desktop" });
    beginPreviewSessionClose(ref, tab.tabId);
    cancelPreviewSessionClose(ref, tab, tab.tabId);
    expect(browserTabs()).toEqual(
      expect.arrayContaining(["browser:tab_closing", "browser:tab_own", "browser:tab_desktop"]),
    );
    expect(shown()).toEqual([]);
  });

  it("follows background threads and drops a revealed tab when its session ends", () => {
    using _following = following();
    const other = scopeThreadRef(ref.environmentId, ThreadId.make("thread-2"));
    reconcilePreviewServerSessions(other, {
      sessions: [serverTab({ threadId: "thread-2", tabId: "tab_b" })],
      serverEpoch,
      revision: 1,
    });
    expect(browserTabs(scopedThreadKey(other))).toEqual(["browser:tab_b"]);

    reconcilePreviewServerSessions(ref, { sessions: [], serverEpoch, revision: 1 });
    const tab = serverTab();
    opened(ref, tab, 2);
    expect(shown()).toEqual(["browser:tab_a"]);
    applyPreviewServerEvent(ref, {
      type: "closed",
      threadId: "thread-1",
      tabId: tab.tabId,
      createdAt: tab.updatedAt,
      serverEpoch,
      revision: 3,
    });
    expect(browserTabs()).toEqual([]);
  });
});
