import "~/index.css";

import {
  createBrowserHistory,
  createMemoryHistory,
  RouterContextProvider,
  type RouterHistory,
} from "@tanstack/react-router";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  type AssistantCitation,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type ScopedThreadRef,
  ThreadId,
  TurnItemId,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { useOpenLink } from "~/browser/useOpenLink";
import { openCommandPalette } from "~/commandPaletteBus";
import { dispatchCommandPalette } from "~/commandPaletteStore";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { useChatTerminalActions } from "~/components/chat/useChatTerminalActions";
import { useRightPanelActions } from "~/components/chat/useRightPanelActions";
import { dispatchPreviewAction } from "~/components/preview/previewActionBus";
import { PullRequestChecksPopover } from "~/components/pullRequest/PullRequestChecksPopover";
import { startMainAppLocationTracking } from "~/components/sidebar/mainAppLocation";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useThreadActions } from "~/hooks/useThreadActions";
import {
  assistantCitationNavigation,
  assistantCitationRoute,
} from "~/lib/assistantCitationNavigation";
import { revealThreadTerminal } from "~/lib/revealThreadTerminal";
import { openLinkedThreadRead } from "~/lib/sideChatPane";
import { applyPreviewServerSnapshot } from "~/previewStateStore";
import { getRouter } from "~/router";
import {
  type RightPanelSurface,
  selectThreadRightPanelState,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { selectThreadTerminalUiState } from "~/terminalUiStateStore";
import {
  answerRpc,
  ENVIRONMENT_ID,
  type FakeDriver,
  type FakeThread,
  installFakeEnvironment,
  PROJECT_ID,
  threadWithHistory,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import { chatFileTarget, openLinkedFolder } from "./chatFileOpener";
import { forgetTabHistoryThread, isTabHistoryWrite } from "./tabHistory";
import { readTabTag } from "./tabHistory.logic";
import { userTabMove } from "./tabMoveScope";
import {
  asTabId,
  focusedTab,
  paneHolding,
  PRIMARY_CHAT,
  replyTabId,
  resolveLayout,
} from "./workArea.logic";
import { restoredRecord, restoreWorkArea } from "./workAreaStorage.logic";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// The app keeps the first test's server config, so the test that needs a browser turns one on here.
const serverBrowser = vi.hoisted(() => ({ on: false }));
vi.mock(import("~/state/entities"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironmentSupportsServerBrowser: (environmentId: EnvironmentId | null) =>
      actual.useEnvironmentSupportsServerBrowser(environmentId) || serverBrowser.on,
    readEnvironmentSupportsServerBrowser: (environmentId: EnvironmentId) =>
      actual.readEnvironmentSupportsServerBrowser(environmentId) || serverBrowser.on,
  };
});

function offerServerBrowser(): Disposable {
  serverBrowser.on = true;
  return { [Symbol.dispose]: () => (serverBrowser.on = false) };
}

const ownerThread = threadWithHistory("owner", 1);
const otherThread = threadWithHistory("other", 1);
const priorThread = threadWithHistory("tab-history-prior", 1);
const doomedThread = threadWithHistory("tab-history-doomed", 1);
const starterThread = threadWithHistory("tab-history-side-chat", 1);
const quoteThread = threadWithHistory("tab-history-quote", 1);
const quoteSideChat: FakeThread = {
  ...threadWithHistory("tab-history-quote-side", 1),
  sideChatOf: quoteThread.id,
};
const goneThread = threadWithHistory("tab-history-gone", 1);
const parentThread = threadWithHistory("tab-history-parent", 1);
const parentSideChat: FakeThread = {
  ...threadWithHistory("tab-history-parent-side", 1),
  sideChatOf: parentThread.id,
};
// The registry keeps the shell and the file list of the first test's environment, so every test
// serves all threads and the same files.
function serve(options?: Parameters<typeof installFakeEnvironment>[1]): Disposable {
  const stack = new DisposableStack();
  stack.use(
    installFakeEnvironment(
      [
        ownerThread,
        otherThread,
        priorThread,
        doomedThread,
        starterThread,
        quoteThread,
        quoteSideChat,
        goneThread,
        parentThread,
        parentSideChat,
      ],
      options,
    ),
  );
  stack.use(
    answerRpc(WS_METHODS.projectsListEntries, () =>
      Effect.succeed({ entries: [{ path: "README.md", kind: "file" }], truncated: false }),
    ),
  );
  return stack;
}
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);
const other = scopeThreadRef(ENVIRONMENT_ID, otherThread.id);
const pathOf = (thread: FakeThread) => `/${ENVIRONMENT_ID}/${thread.id}`;
const ownerPath = pathOf(ownerThread);
const otherPath = pathOf(otherThread);
const FILE = "file:a.ts";
const quoteRef = scopeThreadRef(ENVIRONMENT_ID, quoteThread.id);
const quoteSideRef = scopeThreadRef(ENVIRONMENT_ID, quoteSideChat.id);
const quotePath = pathOf(quoteThread);
const quoteSideTab = `thread:${quoteSideChat.id}`;

const citationOf = (thread: FakeThread): AssistantCitation => ({
  version: 1,
  environmentId: ENVIRONMENT_ID,
  threadId: thread.id,
  messageId: MessageId.make(`${thread.id}-assistant-0`),
  text: "Answer 0",
  start: 0,
  end: 8,
  prefix: "",
  suffix: "",
});

const SURFACES: Record<string, RightPanelSurface> = {
  files: { id: "files", kind: "files" },
  diff: { id: "diff", kind: "diff" },
  [FILE]: { id: FILE, kind: "file", relativePath: "a.ts", revealLine: null, revealRequestId: 0 },
  "browser:tab-a": { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
  "browser:tab-b": { id: "browser:tab-b", kind: "preview", resourceId: "tab-b" },
};

const previewSnapshot = (tabId: string) =>
  ({
    runtime: "server",
    threadId: owner.threadId,
    tabId,
    navStatus: { _tag: "Idle" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-11-25T00:00:00.000Z",
  }) as const;

/** One pane: the Chat, then `tabs`, with `active` shown. */
function tabsRecord(
  tabs: readonly string[] = ["files", "diff", FILE],
  active = "chat",
): ThreadRightPanelState {
  return restoredRecord({
    isOpen: true,
    activeSurfaceId: null,
    surfaces: tabs.map((tab) => SURFACES[tab]!),
    workArea: restoreWorkArea({
      root: { kind: "pane", id: "p0", tabs: ["chat", ...tabs], active },
      tabs: {
        chat: { kind: "primary-chat" },
        ...Object.fromEntries(tabs.map((tab) => [tab, { kind: "surface" }])),
      },
      focused: "p0",
      seq: 1,
    })!,
  });
}

function setup(
  records: ReadonlyArray<readonly [ScopedThreadRef, ThreadRightPanelState]>,
  settings: Partial<typeof DEFAULT_CLIENT_SETTINGS> = {},
) {
  useRightPanelStore.setState({
    byThreadKey: Object.fromEntries(records.map(([ref, record]) => [scopedThreadKey(ref), record])),
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    ...settings,
  });
}

const NARROW = { width: 800, height: 900 };
const WIDE = { width: 1400, height: 900 };

async function openApp(
  entries: readonly string[],
  {
    size = NARROW,
    thread = ownerThread,
    prepare,
  }: {
    size?: typeof NARROW;
    thread?: FakeThread;
    prepare?: (history: RouterHistory) => void;
  } = {},
) {
  await page.viewport(size.width, size.height);
  const history = createMemoryHistory({ initialEntries: [...entries] });
  prepare?.(history);
  const router = getRouter(history);
  await router.load();
  await using stack = new AsyncDisposableStack();
  // AppRoot brings its own router.
  const app = stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect.element(composerOf(thread)).toBeVisible();
  stack.move();
  return Object.assign(app, { router, history });
}

const composerOf = (thread: FakeThread) =>
  page.getByRole("textbox", { name: `Message ${thread.title}` });

const layoutOf = (ref: ScopedThreadRef) =>
  resolveLayout(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref));
const shownTab = (ref: ScopedThreadRef = owner) => focusedTab(layoutOf(ref));

async function tap(tab: string, ref: ScopedThreadRef = owner) {
  await userEvent.click(document.querySelector(`[data-right-panel-tab-id="${CSS.escape(tab)}"]`)!);
  await vi.waitFor(() => expect(shownTab(ref)).toBe(tab));
}

/** The action of every history notification until disposed. */
function historyLog(history: RouterHistory): Disposable & { readonly actions: string[] } {
  const actions: string[] = [];
  const stop = history.subscribe(({ action }) => actions.push(action.type));
  return { actions, [Symbol.dispose]: stop };
}

/** Counts calls of `history[step]` and stops passing them on after `limit`, so a runaway walk ends. */
function countSteps(history: RouterHistory, step: "back" | "forward", limit = 20) {
  const real = history[step];
  const counter = { calls: 0 };
  const spy = vi.spyOn(history, step).mockImplementation((options) => {
    counter.calls += 1;
    if (counter.calls <= limit) real(options);
  });
  return Object.assign(counter, { [Symbol.dispose]: () => spy.mockRestore() });
}

const at = (history: RouterHistory) => history.location.state.__TSR_index;

/** A tag as an earlier document wrote it into the history. */
const tagState = (ref: ScopedThreadRef, tab: string, id = `earlier-${tab}`) => ({
  workAreaTab: { ...ref, tab: asTabId(tab), id },
});

const sidebarNavigation = (ref: ScopedThreadRef) =>
  ({
    to: "/$environmentId/$threadId",
    params: { environmentId: ref.environmentId, threadId: ref.threadId },
  }) as const;

describe("narrow tab history", () => {
  it("makes each tab tap one Back stop on the thread's own URL, and walks them back and forth", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([otherPath, ownerPath]);
    const { history, router } = app;

    await tap("files");
    await tap("diff");
    expect(history.length).toBe(4);
    const revision = () =>
      useRightPanelStore.getState().userActionRevisionByThreadKey[scopedThreadKey(owner)];
    const tapped = revision();

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    expect(router.state.location.href).toBe(ownerPath);
    // A restore is not the user's action: it cancels no pending offer or file-link lookup.
    expect(revision()).toBe(tapped);
    history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(otherPath));

    // The owner's store moves on while another page shows; its first entry still shows the Chat.
    await act(() =>
      useRightPanelStore
        .getState()
        .updateWorkArea(owner, { type: "activate", tab: asTabId("diff") }),
    );
    history.forward();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    history.forward();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
    history.forward();
    await vi.waitFor(() => expect(shownTab()).toBe("diff"));
    expect(router.state.location.href).toBe(ownerPath);
    expect(history.length).toBe(4);
  });

  it("skips a closed tab both ways, and skips a stop that would repeat the shown tab", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([ownerPath]);
    const { history } = app;
    await tap("files");
    await tap("diff");
    await tap(FILE);

    await act(() => useRightPanelStore.getState().closeSurface(owner, "diff"));
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
    expect(at(history)).toBe(1);
    history.forward();
    await vi.waitFor(() => expect(shownTab()).toBe(FILE));
    expect(at(history)).toBe(3);

    // Closing the shown tab shows Files and writes no history; the Files stop below would change
    // nothing, so one Back reaches the Chat.
    await userEvent.click(page.getByRole("button", { name: "Close a.ts" }));
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
    expect(history.length).toBe(4);
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    expect(at(history)).toBe(0);
  });

  it("ends a walk at the last entry and never steps back from the first when every tab is closed", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([ownerPath]);
    const { history } = app;
    await tap("files");
    await tap("diff");
    await tap(FILE);
    history.go(-3);
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    await act(() => {
      for (const tab of ["files", "diff", FILE]) {
        useRightPanelStore.getState().closeSurface(owner, tab);
      }
    });

    using forward = countSteps(history, "forward");
    history.forward();
    await vi.waitFor(() => expect(at(history)).toBe(3));
    // One press, two skips, and one skip that found no entry after the last.
    expect(forward.calls).toBe(4);

    using back = countSteps(history, "back");
    history.back();
    await vi.waitFor(() => expect(at(history)).toBe(0));
    expect(back.calls).toBe(3);
    expect(shownTab()).toBe("chat");
  });

  it("restores each entry's tab in its own thread across a thread switch", async () => {
    using _environment = serve();
    setup([
      [owner, tabsRecord()],
      [other, tabsRecord(["diff"])],
    ]);
    await using app = await openApp([ownerPath]);
    const { history, router } = app;
    await tap("files");
    await act(() => router.navigate(sidebarNavigation(other)));
    await expect.element(composerOf(otherThread)).toBeVisible();
    await tap("diff", other);
    expect(history.length).toBe(4);
    // The owner's store moves on while the other thread shows.
    await act(() =>
      useRightPanelStore
        .getState()
        .updateWorkArea(owner, { type: "activate", tab: asTabId("diff") }),
    );

    history.back();
    await vi.waitFor(() => expect(shownTab(other)).toBe("chat"));
    expect(router.state.location.pathname).toBe(otherPath);
    history.back();
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe(ownerPath);
      expect(shownTab()).toBe("files");
    });
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
  });

  it("writes no history and restores nothing in a wide window, so Back leaves the thread", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([otherPath, ownerPath], { size: WIDE });
    const { history, router } = app;
    using log = historyLog(history);

    await tap("files");
    await tap("diff");
    expect(log.actions).toEqual([]);
    expect(history.length).toBe(2);
    const record = useRightPanelStore.getState().byThreadKey[scopedThreadKey(owner)];

    history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(otherPath));
    expect(log.actions).toEqual(["BACK"]);
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(owner)]).toBe(record);
  });

  it("starts recording from the shown tab when the window narrows, and goes inert when it widens", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([ownerPath], { size: WIDE });
    const { history } = app;

    await tap("files");
    expect(history.length).toBe(1);
    await page.viewport(NARROW.width, NARROW.height);
    using log = historyLog(history);
    await tap("diff");
    expect(log.actions).toEqual(["REPLACE", "PUSH"]);
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
    history.forward();
    await vi.waitFor(() => expect(shownTab()).toBe("diff"));

    await page.viewport(WIDE.width, WIDE.height);
    const record = useRightPanelStore.getState().byThreadKey[scopedThreadKey(owner)];
    history.back();
    await act(() => Promise.resolve());
    expect(at(history)).toBe(0);
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(owner)]).toBe(record);
  });

  it("makes an agent's reveal no stop, and the tab the user left when the user taps on", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([ownerPath]);
    const { history } = app;
    await tap("files");

    await act(() => useRightPanelStore.getState().revealSurface(owner, "diff"));
    expect(shownTab()).toBe("diff");
    expect(history.length).toBe(2);
    await tap(FILE);
    expect(history.length).toBe(3);

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("diff"));
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
  });

  it("adds no stop and keeps Forward for Find's reveals, and records a reply the user opens", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([ownerPath]);
    const { history } = app;
    await tap("files");
    await tap("diff");
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));

    const chat = chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, owner);
    const reply = replyTabId(owner, "owner-assistant-0");
    await act(() => chat.openSubThread("owner-assistant-0", { reveal: "find" }));
    expect(shownTab()).toBe(reply);
    await act(() => chat.showOrigin());
    expect(shownTab()).toBe("chat");
    expect(history.length).toBe(3);
    expect(at(history)).toBe(1);

    history.forward();
    await vi.waitFor(() => expect(shownTab()).toBe("diff"));
    await act(() => chat.openSubThread("owner-assistant-0"));
    expect(shownTab()).toBe(reply);
    expect(history.length).toBe(4);
  });

  it("tags a quote link's entry with the tab the user left, and pushes the next tap without the quote", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([otherPath, ownerPath]);
    const { history, router } = app;
    await act(() => router.navigate(assistantCitationNavigation(citationOf(ownerThread), null)));
    const quoted = router.state.location.href;
    expect(quoted).toContain("#assistant-citation=");
    expect(shownTab()).toBe("chat");

    await tap("files");
    expect(router.state.location.href).toBe(ownerPath);
    expect(history.length).toBe(4);

    using log = historyLog(history);
    history.back();
    await vi.waitFor(() => expect(router.state.location.href).toBe(quoted));
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    history.forward();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    // Then the entry from before the quote, and the page before the thread.
    history.back();
    await vi.waitFor(() => expect(router.state.location.href).toBe(ownerPath));
    expect(at(history)).toBe(1);
    history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(otherPath));
    // No pop re-runs a reveal that writes history.
    expect(log.actions.filter((action) => action === "PUSH" || action === "REPLACE")).toEqual([]);
    expect(history.length).toBe(4);
  });

  it("reveals a quote again when the user opens it from its own tab entry", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([ownerPath]);
    const { history, router } = app;
    const highlighted = () => document.querySelector("[data-citation-highlighted]");
    const openQuote = () =>
      router.navigate(assistantCitationNavigation(citationOf(ownerThread), null));
    await act(openQuote);
    await vi.waitFor(() => expect(highlighted()).not.toBeNull());
    await tap("files");
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    // The tab entry owns the screen, so its quote shows no highlight.
    await vi.waitFor(() => expect(highlighted()).toBeNull());

    await act(openQuote);
    await vi.waitFor(() => expect(highlighted()).not.toBeNull());
    expect(readTabTag(history.location.state)).toBeNull();
  });

  it("shows the tab a side chat quote's entry names on Back, with no reveal over it", async () => {
    using _environment = serve();
    setup([[quoteRef, tabsRecord()]]);
    await using app = await openApp([quotePath], { thread: quoteThread });
    const { history, router } = app;
    await vi.waitFor(() => expect(readThreadShell(quoteSideRef)).not.toBeNull());
    const citation = citationOf(quoteSideChat);
    await act(() =>
      router.navigate(assistantCitationNavigation(citation, readThreadShell(quoteSideRef))),
    );
    const quoted = router.state.location.href;
    // An untagged quote entry reveals its side chat as before.
    await vi.waitFor(() => expect(shownTab(quoteRef)).toBe(quoteSideTab));
    expect(history.length).toBe(2);
    // An agent shows Files; the user then taps Diff.
    await act(() => useRightPanelStore.getState().revealSurface(quoteRef, "files"));
    await tap("diff", quoteRef);
    expect(history.length).toBe(3);

    history.back();
    await vi.waitFor(() => expect(router.state.resolvedLocation?.href).toBe(quoted));
    await vi.waitFor(() => expect(shownTab(quoteRef)).toBe("files"));
    await act(() => Promise.resolve());
    expect(shownTab(quoteRef)).toBe("files");
    history.forward();
    await vi.waitFor(() => expect(shownTab(quoteRef)).toBe("diff"));
  });

  it("still reveals a quote on a tagged entry in a wide window", async () => {
    using _environment = serve();
    setup([[quoteRef, tabsRecord()]]);
    const quoted = `${quotePath}#${assistantCitationRoute(citationOf(quoteSideChat), null).hash}`;
    await using _app = await openApp([quoted], {
      size: WIDE,
      thread: quoteThread,
      // A narrow window tagged this quote entry before it widened.
      prepare: (history) =>
        history.replace(quoted, {
          ...tagState(quoteRef, "files"),
          assistantCitationActivation: "earlier",
        }),
    });
    await vi.waitFor(() =>
      expect(paneHolding(layoutOf(quoteRef).root, asTabId(quoteSideTab))).toBeDefined(),
    );
  });

  it("makes a menu open that settles after an await one stop, from the tab shown when it lands", async () => {
    const starterRef = scopeThreadRef(ENVIRONMENT_ID, starterThread.id);
    using _environment = serve({ acceptCommands: true });
    setup([[starterRef, tabsRecord(["files", "diff"])]]);
    await using app = await openApp([pathOf(starterThread)], { thread: starterThread });
    const { history } = app;

    await userEvent.click(page.getByRole("button", { name: "Add panel surface" }));
    const pick = page.getByRole("menuitem", { name: /Side chat/ });
    await expect.element(pick).toBeVisible();
    // The side chat exists only after its fork reaches this client; an agent shows Diff first.
    (pick.element() as HTMLElement).click();
    useRightPanelStore.getState().revealSurface(starterRef, "diff");

    await vi.waitFor(() => expect(shownTab(starterRef)).toMatch(/^thread:/));
    expect(history.length).toBe(2);
    history.back();
    await vi.waitFor(() => expect(shownTab(starterRef)).toBe("diff"));
  });

  it("makes a Files tree row one stop, and Back skips the Files tab the file replaced", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord(["files"])]]);
    await using app = await openApp([ownerPath]);
    const { history } = app;
    await tap("files");
    const before = at(history);
    // The tree draws its rows in a shadow root.
    const row = () => {
      for (const host of document.querySelectorAll("*")) {
        const item = host.shadowRoot?.querySelector<HTMLElement>('[data-item-path="README.md"]');
        if (item) return item;
      }
      return null;
    };
    await vi.waitFor(() => expect(row()).not.toBeNull());
    await userEvent.click(row()!);
    await vi.waitFor(() => expect(shownTab()).toBe("file:README.md"));
    expect(at(history)).toBe(before + 1);
    expect(paneHolding(layoutOf(owner).root, asTabId("files"))).toBeUndefined();

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    expect(at(history)).toBe(before - 1);
  });

  it("makes the Preview toggle one stop when it opens a browser session, and Back shows the tab before", async () => {
    using _environment = serve();
    using _browser = offerServerBrowser();
    setup([[owner, tabsRecord(["files"])]]);
    await using app = await openApp([ownerPath]);
    const { history } = app;
    await tap("files");
    await act(() => applyPreviewServerSnapshot(owner, previewSnapshot("tab-history-preview")));
    const before = at(history);
    await act(() => dispatchPreviewAction("toggle-panel"));
    await vi.waitFor(() => expect(shownTab()).toBe("browser:tab-history-preview"));
    expect(at(history)).toBe(before + 1);

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
  });

  it.each<[string, (actions: ReturnType<typeof useRightPanelActions>) => void]>([
    [
      "a tool call's Open diff",
      (actions) =>
        actions.onOpenToolDiffStable({
          threadId: ownerThread.id,
          itemId: TurnItemId.make("owner-file-change"),
          revision: "r1",
        }),
    ],
    ["Git's Open changes", (actions) => actions.openChangesFromThreadPanelStable()],
  ])("makes %s one stop, and Back shows the Chat", async (_name, run) => {
    using _environment = serve();
    setup([[owner, tabsRecord(["files"])]]);
    await using app = await openApp([otherPath, ownerPath]);
    const { history, router } = app;
    const before = at(history);
    function RunAction() {
      const actions = useRightPanelActions({
        activeThreadRef: owner,
        activeProject: null,
        activeRightPanelSurface: null,
        activePreviewState: { sessions: {}, activeTabId: null } as never,
        deviceState: {} as never,
        deviceStateLoaded: false,
        pullRequestPanelTarget: null,
        threadPanelPresentation: "inline",
        isServerThread: true,
        embedded: true,
        diffAvailable: true,
        browserAvailable: false,
        canOperatePreview: false,
        diffOpen: false,
        previewPanelOpen: false,
        rightPanelOpen: true,
        canMaximizeRightPanel: false,
        rightPanelMaximized: false,
        supportsPullRequests: false,
        pullRequestsSurfaceAvailable: false,
        gitCwd: null,
        activeProjectCwd: null,
        onDiffPanelOpen: undefined,
        closeRightPanelSurface: () => {},
      });
      return (
        <button type="button" onClick={() => run(actions)}>
          Run the action
        </button>
      );
    }
    // The chat's own controls need a tool call or a Git folder; this tree runs the same handlers.
    await using _actions = await render(
      <AppAtomRegistryProvider>
        <RunAction />
      </AppAtomRegistryProvider>,
      { router: false },
    );
    (page.getByRole("button", { name: "Run the action" }).element() as HTMLElement).click();
    await vi.waitFor(() => expect(shownTab()).toBe("diff"));
    expect(at(history)).toBe(before + 1);

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    expect(router.state.location.pathname).toBe(ownerPath);
  });

  it("restores a tagged entry on the first Back after a reload, from a page with no work area", async () => {
    using _environment = serve();
    await page.viewport(NARROW.width, NARROW.height);
    setup([[owner, tabsRecord()]]);
    const history = createMemoryHistory({ initialEntries: [ownerPath, ownerPath, "/issues"] });
    history.go(-2);
    history.replace(ownerPath, tagState(owner, "chat"));
    history.forward();
    history.replace(ownerPath, tagState(owner, "files"));
    history.forward();
    const router = getRouter(history);
    await router.load();
    await using _app = await render(<AppRoot router={router} />, { router: false });
    expect(document.querySelector("[data-work-area]")).toBeNull();

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
  });

  it("measures the first pop after the app mounts from where the history was then", async () => {
    using _environment = serve();
    await page.viewport(NARROW.width, NARROW.height);
    setup([[owner, tabsRecord()]]);
    const history = createMemoryHistory({
      initialEntries: [otherPath, ownerPath, ownerPath, "/issues"],
    });
    history.go(-2);
    history.replace(ownerPath, tagState(owner, "chat"));
    history.forward();
    history.replace(ownerPath, tagState(owner, "files"));
    history.forward();
    const router = getRouter(history);
    await router.load();
    // A Back before the app mounts, which neither the router nor tab history hears.
    history.back();
    await using _app = await render(<AppRoot router={router} />, { router: false });
    await expect.element(composerOf(ownerThread)).toBeVisible();
    expect(shownTab()).toBe("chat");

    // The Chat stop below would change nothing, so Back leaves the thread.
    history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(otherPath));
  });

  it("loads a navigation made before the app mounts", async () => {
    await page.viewport(WIDE.width, WIDE.height);
    const history = createMemoryHistory({ initialEntries: ["/issues"] });
    const router = getRouter(history);
    await router.load();
    let resolved = false;
    void router.navigate({ href: "/pull-requests" }).then(() => (resolved = true));
    await vi.waitFor(() =>
      expect({ resolved, pathname: router.state.location.pathname }).toEqual({
        resolved: true,
        pathname: "/pull-requests",
      }),
    );
  });

  it("marks its own writes before the router's own subscriber hears them", async () => {
    await page.viewport(NARROW.width, NARROW.height);
    setup([[owner, tabsRecord()]]);
    const history = createMemoryHistory({ initialEntries: [ownerPath] });
    const router = getRouter(history);
    const heard: Array<readonly [string, boolean]> = [];
    // The first subscriber, as the router's Transitioner is in the app.
    using _follow = {
      [Symbol.dispose]: history.subscribe(({ action, location }) => {
        heard.push([action.type, isTabHistoryWrite(location)]);
        void router.load();
      }),
    };
    await router.load();
    userTabMove(owner, () =>
      useRightPanelStore
        .getState()
        .updateWorkArea(owner, { type: "activate", tab: asTabId("files") }),
    );
    expect(heard).toEqual([
      ["REPLACE", true],
      ["PUSH", true],
    ]);
  });

  it.each([
    ["shows the same tab with one stop below it", false, 1, "files"],
    // Back then skips the Files stop, which would repeat the shown tab.
    ["keeps a tab an agent showed after the last tap", true, 0, "chat"],
  ])("closes Settings to the thread: %s", async (_name, revealAfter, below, belowTab) => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([ownerPath]);
    const { history, router } = app;
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    await tap("files");
    await tap("diff");
    if (revealAfter) await act(() => useRightPanelStore.getState().revealSurface(owner, "files"));
    const shown = shownTab();

    await closeSettings(app);

    expect(history.length).toBe(3);
    expect(readTabTag(history.location.state)?.tab).toBe("diff");
    expect(shownTab()).toBe(shown);
    history.back();
    await vi.waitFor(() => expect(at(history)).toBe(below));
    await vi.waitFor(() => expect(shownTab()).toBe(belowTab));
  });

  it("closes Settings past an equal tag below its return entry, leaving no Settings in Forward", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([ownerPath]);
    const { history, router } = app;
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    await tap("files");
    await tap("diff");
    // An agent shows Files, so the next tap tags the Diff entry with Files too.
    await act(() => useRightPanelStore.getState().revealSurface(owner, "files"));
    await tap(FILE);
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
    expect(at(history)).toBe(2);

    await closeSettings(app);

    expect(history.length).toBe(3);
    expect(at(history)).toBe(2);
    history.forward();
    await act(() => Promise.resolve());
    expect(router.state.location.pathname).toBe(ownerPath);
  });

  it("records no tab move in a thread that Settings covers", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([ownerPath]);
    const { history, router } = app;
    await act(() => router.navigate({ to: "/settings/general" }));
    await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();

    using log = historyLog(history);
    await act(() =>
      userTabMove(owner, () =>
        useRightPanelStore
          .getState()
          .updateWorkArea(owner, { type: "activate", tab: asTabId("files") }),
      ),
    );
    expect(shownTab()).toBe("files");
    expect(log.actions).toEqual([]);
  });

  it("keeps Forward when the sidebar navigates to the current thread from a tab entry", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp([ownerPath]);
    const { history, router } = app;
    await tap("files");
    await tap("diff");
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));

    using log = historyLog(history);
    await act(() => router.navigate(sidebarNavigation(owner)));
    expect(log.actions).toEqual([]);
    history.forward();
    await vi.waitFor(() => expect(shownTab()).toBe("diff"));
  });

  it("keeps Forward for that navigation from a tab entry with state of its own", async () => {
    await page.viewport(NARROW.width, NARROW.height);
    setup([[owner, tabsRecord(["files"])]]);
    const history = createMemoryHistory({ initialEntries: [ownerPath] });
    // A cross-thread Reopen Closed View leaves this state on its destination entry.
    history.replace(ownerPath, { reopenedViewId: "closed-view" });
    const router = getRouter(history);
    // With no app mounted, the router follows the history as its Transitioner would.
    using _follow = { [Symbol.dispose]: history.subscribe(() => void router.load()) };
    await router.load();
    userTabMove(owner, () =>
      useRightPanelStore
        .getState()
        .updateWorkArea(owner, { type: "activate", tab: asTabId("files") }),
    );
    await vi.waitFor(() => expect(at(history)).toBe(1));
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    expect(history.location.state.reopenedViewId).toBe("closed-view");

    using log = historyLog(history);
    await act(() => router.navigate(sidebarNavigation(owner)));
    expect(log.actions).toEqual([]);
    history.forward();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
  });

  it("keeps Forward for that navigation in a wide window reloaded on a tab entry", async () => {
    await page.viewport(WIDE.width, WIDE.height);
    setup([[owner, tabsRecord()]]);
    const history = createMemoryHistory({
      initialEntries: [ownerPath, ownerPath, ownerPath],
      initialIndex: 1,
    });
    history.replace(ownerPath, tagState(owner, "files"));
    history.back();
    history.replace(ownerPath, tagState(owner, "chat"));
    history.go(2);
    history.replace(ownerPath, tagState(owner, "diff"));
    history.back();
    const router = getRouter(history);
    // With no app mounted, the router follows the history as its Transitioner would.
    using _follow = { [Symbol.dispose]: history.subscribe(() => void router.load()) };
    await router.load();

    using log = historyLog(history);
    await router.navigate(sidebarNavigation(owner));
    expect(log.actions).toEqual([]);
    history.forward();
    expect(at(history)).toBe(2);
  });

  it("keeps the fallback after a tab tap during a delete, and skips the deleted thread's entries on Back", async () => {
    const doomedRef = scopeThreadRef(ENVIRONMENT_ID, doomedThread.id);
    using _environment = serve();
    const deleting = Promise.withResolvers<void>();
    const deleted = Promise.withResolvers<void>();
    using _dispatch = answerRpc(
      ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
      (command: { readonly type: string; readonly threadId?: string }) => {
        if (command.type !== "thread.delete" || command.threadId !== doomedThread.id) {
          return Effect.succeed({ sequence: 2 });
        }
        deleting.resolve();
        return Effect.promise(() => deleted.promise).pipe(Effect.as({ sequence: 2 }));
      },
    );
    // Delete first stops the thread's provider sessions, which it reads from this projection.
    using _projection = answerRpc(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, () =>
      Effect.succeed({}),
    );
    setup([[doomedRef, tabsRecord()]]);
    // An entry of the thread from before any tap stays untagged.
    await using app = await openApp(
      [pathOf(priorThread), pathOf(doomedThread), pathOf(doomedThread)],
      {
        thread: doomedThread,
      },
    );
    const { history, router } = app;
    await tap("files", doomedRef);
    // Delete takes its full path, with the fallback, only for a thread the shell lists.
    await vi.waitFor(() => expect(readThreadShell(doomedRef)).not.toBeNull());

    let finished: Promise<unknown> = Promise.resolve();
    function DeleteDoomed() {
      const { deleteThread } = useThreadActions();
      return (
        <button type="button" onClick={() => (finished = deleteThread(doomedRef))}>
          Delete the thread
        </button>
      );
    }
    // The app's own tree has no control for this; this one shares its router and atom registry.
    await using _delete = await render(
      <AppAtomRegistryProvider>
        <RouterContextProvider router={router}>
          <DeleteDoomed />
        </RouterContextProvider>
      </AppAtomRegistryProvider>,
      { router: false },
    );
    // The app's layout covers this tree's container.
    (page.getByRole("button", { name: "Delete the thread" }).element() as HTMLElement).click();
    await deleting.promise;
    await tap("diff", doomedRef);
    expect(history.length).toBe(5);
    deleted.resolve();
    await act(() => finished);

    await vi.waitFor(() => expect(router.state.location.pathname).not.toBe(pathOf(doomedThread)));
    expect(at(history)).toBe(4);
    history.back();
    await vi.waitFor(() => expect(at(history)).toBe(0));
    expect(router.state.location.pathname).toBe(pathOf(priorThread));
  });

  it("restores through the browser's own Back after a reload, and keeps a retag pushed in the same task", async () => {
    await page.viewport(NARROW.width, NARROW.height);
    setup([[owner, tabsRecord()]]);
    const start = { href: location.href, state: window.history.state as unknown };
    const entry = (index: number, extra = {}) => ({
      __TSR_index: index,
      key: `seed-${index}`,
      __TSR_key: `seed-${index}`,
      ...extra,
    });
    // What an earlier document left: two tab entries of the owner, then Issues.
    window.history.pushState(entry(1, tagState(owner, "chat")), "", ownerPath);
    window.history.pushState(entry(2, tagState(owner, "files")), "", ownerPath);
    window.history.pushState(entry(3), "", "/issues");
    const history = createBrowserHistory();
    using _history = {
      [Symbol.dispose]: () => {
        history.destroy();
        window.history.replaceState(start.state, "", start.href);
      },
    };
    const router = getRouter(history);
    // With no app mounted, the router follows the history as its Transitioner would.
    using _follow = { [Symbol.dispose]: history.subscribe(() => void router.load()) };
    await router.load();

    window.history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(ownerPath));

    // An agent shows Diff, then a tap tags this entry with Diff and pushes, all in one task.
    useRightPanelStore.getState().revealSurface(owner, "diff");
    userTabMove(owner, () =>
      useRightPanelStore.getState().updateWorkArea(owner, { type: "activate", tab: asTabId(FILE) }),
    );
    await vi.waitFor(() => expect(window.history.state?.__TSR_index).toBe(3));

    window.history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("diff"));
    expect(window.history.state?.__TSR_index).toBe(2);
  });

  it("stops on the first open stop past a closed tab when Back comes from another thread", async () => {
    using _environment = serve();
    setup([
      [owner, tabsRecord()],
      [other, tabsRecord(["diff"])],
    ]);
    await using app = await openApp([ownerPath]);
    const { history, router } = app;
    await tap("files");
    await tap("diff");
    await act(() => router.navigate(sidebarNavigation(other)));
    await expect.element(composerOf(otherThread)).toBeVisible();
    // While the other thread shows, the owner's Diff closes and its Files shows.
    await act(() => {
      useRightPanelStore.getState().closeSurface(owner, "diff");
      useRightPanelStore
        .getState()
        .updateWorkArea(owner, { type: "activate", tab: asTabId("files") });
    });

    // The closed Diff stop changes the page, so Back stays there and the thread shows its Files.
    history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(ownerPath));
    await act(() => Promise.resolve());
    expect(at(history)).toBe(2);
    expect(shownTab()).toBe("files");
    // On the thread's own page, Back skips the Files stop, which repeats the shown tab.
    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    expect(at(history)).toBe(0);
  });

  it("steps past a deleted thread and then past a stop that repeats the tab Back started on", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord()]]);
    await using app = await openApp(
      [pathOf(priorThread), ownerPath, pathOf(goneThread), ownerPath],
      {
        prepare: (history) => {
          history.go(-2);
          history.replace(ownerPath, tagState(owner, "chat", "earlier-chat-1"));
          history.go(2);
          history.replace(ownerPath, tagState(owner, "chat", "earlier-chat-2"));
        },
      },
    );
    const { history, router } = app;
    forgetTabHistoryThread(scopeThreadRef(ENVIRONMENT_ID, goneThread.id));

    history.back();
    await vi.waitFor(() => expect(at(history)).toBe(0));
    expect(router.state.location.pathname).toBe(pathOf(priorThread));
  });

  it("makes the browser tab Back shows the active preview session, so the Preview toggle opens it", async () => {
    using _environment = serve();
    using _browser = offerServerBrowser();
    setup([[owner, tabsRecord(["browser:tab-a", "browser:tab-b"])]]);
    await using app = await openApp([ownerPath]);
    const { history } = app;
    for (const tabId of ["tab-a", "tab-b"]) {
      await act(() => applyPreviewServerSnapshot(owner, previewSnapshot(tabId)));
    }
    await tap("browser:tab-b");
    await tap("browser:tab-a");

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("browser:tab-b"));
    await tap(PRIMARY_CHAT);
    await act(() => dispatchPreviewAction("toggle-panel"));
    await vi.waitFor(() => expect(shownTab()).toBe("browser:tab-b"));
  });

  it("makes a command palette file open one stop, and Back shows the tab before", async () => {
    using _environment = serve();
    using _search = answerRpc(WS_METHODS.projectsSearchEntries, () =>
      Effect.succeed({ entries: [{ path: "README.md", kind: "file" }], truncated: false }),
    );
    setup([[owner, tabsRecord(["diff"])]]);
    await using app = await openApp([ownerPath]);
    const { history } = app;
    await tap("diff");
    const before = at(history);

    openCommandPalette({});
    await act(() =>
      dispatchCommandPalette({
        _tag: "OpenChildSearch",
        mode: "files",
        context: { query: "", linkedThreadSearch: null },
      }),
    );
    await userEvent.click(page.getByRole("option", { name: /README\.md/ }));
    await vi.waitFor(() => expect(shownTab()).toBe("file:README.md"));
    expect(at(history)).toBe(before + 1);

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("diff"));
  });

  it("makes the terminal.new shortcut one stop, and Back shows the tab before", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord(["files"])]]);
    await using app = await openApp([ownerPath]);
    const { history } = app;
    await tap("files");
    const before = at(history);
    function NewTerminal() {
      const actions = useChatTerminalActions({
        environmentId: ENVIRONMENT_ID,
        composerRef: { current: null },
        terminalUiState: selectThreadTerminalUiState({}, owner),
        activeThread: undefined,
        activeThreadId: owner.threadId,
        activeThreadRef: owner,
        activeProject: null,
        activeRightPanelSurface: null,
        runningTerminalIds: [],
        activeServerOrderedTerminalIds: [],
        activeTerminalLabelsById: new Map(),
        panelTerminalIds: new Set(),
        canReuseTerminal: false,
        gitCwd: null,
        setTerminalUiLaunchContext: () => {},
        setThreadError: () => {},
      });
      return (
        <button type="button" onClick={() => actions.shortcuts["terminal.new"]()}>
          Press terminal.new
        </button>
      );
    }
    // The chord needs a focused terminal; this tree runs the chat's own shortcut handler.
    await using _shortcut = await render(
      <AppAtomRegistryProvider>
        <NewTerminal />
      </AppAtomRegistryProvider>,
      { router: false },
    );
    (page.getByRole("button", { name: "Press terminal.new" }).element() as HTMLElement).click();
    await vi.waitFor(() => expect(shownTab()).toMatch(/^terminal:/));
    expect(at(history)).toBe(before + 1);

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
  });

  it("makes a linked thread open into the panel one stop, and Back shows the tab before", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord(["files"])]]);
    await using app = await openApp([ownerPath]);
    const { history, router } = app;
    await tap("files");
    const before = at(history);

    await act(() =>
      openLinkedThreadRead({
        panelRef: owner,
        target: {
          viaEnvironmentId: ENVIRONMENT_ID,
          environmentId: EnvironmentId.make("tab-history-linked-environment"),
          threadId: ThreadId.make("tab-history-linked-thread"),
          label: "Linked",
          title: null,
        },
        intent: "panel",
        navigate: router.navigate,
      }),
    );
    await vi.waitFor(() => expect(shownTab()).toMatch(/^linked-thread:/));
    expect(at(history)).toBe(before + 1);

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
  });

  it("makes the status terminal one stop when it opens a terminal with no tab, and Back shows the tab before", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord(["files"])]]);
    await using app = await openApp([ownerPath]);
    const { history } = app;
    await tap("files");
    const before = at(history);

    await act(() => revealThreadTerminal(owner, "tab-history-status"));
    await vi.waitFor(() => expect(shownTab()).toBe("terminal:tab-history-status"));
    expect(at(history)).toBe(before + 1);

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
  });

  it("makes a linked file's folder breadcrumb one stop on the folder it shows", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord(["diff"])]]);
    await using app = await openApp([ownerPath]);
    const { history } = app;
    const before = at(history);

    await act(() => openLinkedFolder(owner, PRIMARY_CHAT, "src", "src"));
    await vi.waitFor(() => expect(shownTab()).toBe("file:src"));
    expect(at(history)).toBe(before + 1);

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    history.forward();
    await vi.waitFor(() => expect(shownTab()).toBe("file:src"));
  });

  it("skips the entries of a deleted thread's side chats on Back, as its own", async () => {
    const parentRef = scopeThreadRef(ENVIRONMENT_ID, parentThread.id);
    const sideRef = scopeThreadRef(ENVIRONMENT_ID, parentSideChat.id);
    using _environment = serve();
    using _dispatch = answerRpc(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, () =>
      Effect.succeed({ sequence: 2 }),
    );
    using _projection = answerRpc(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, () =>
      Effect.succeed({}),
    );
    setup([[parentRef, tabsRecord()]]);
    // The side chat was once open on the main screen.
    await using app = await openApp(
      [pathOf(priorThread), pathOf(parentSideChat), pathOf(parentThread)],
      { thread: parentThread },
    );
    const { history, router } = app;
    await vi.waitFor(() => {
      expect(readThreadShell(parentRef)).not.toBeNull();
      expect(readThreadShell(sideRef)).not.toBeNull();
    });

    let finished: Promise<unknown> = Promise.resolve();
    function DeleteParent() {
      const { deleteThread } = useThreadActions();
      return (
        <button type="button" onClick={() => (finished = deleteThread(parentRef))}>
          Delete the parent
        </button>
      );
    }
    await using _delete = await render(
      <AppAtomRegistryProvider>
        <RouterContextProvider router={router}>
          <DeleteParent />
        </RouterContextProvider>
      </AppAtomRegistryProvider>,
      { router: false },
    );
    (page.getByRole("button", { name: "Delete the parent" }).element() as HTMLElement).click();
    await act(() => finished);
    await vi.waitFor(() => expect(router.state.location.pathname).not.toBe(pathOf(parentThread)));

    history.back();
    await vi.waitFor(() => expect(at(history)).toBe(0));
    expect(router.state.location.pathname).toBe(pathOf(priorThread));
  });

  it("lands on an earlier thread visit when Back comes from another thread and its tabs closed", async () => {
    using _environment = serve();
    setup([[owner, tabsRecord(["files"], "files")]]);
    await using app = await openApp([pathOf(priorThread), ownerPath]);
    const { history, router } = app;
    // The file opened from the Files tree replaces the Files tab; the user then closes it.
    await vi.waitFor(() => expect(filesRow("README.md")).not.toBeNull());
    await userEvent.click(filesRow("README.md")!);
    await vi.waitFor(() => expect(shownTab()).toBe("file:README.md"));
    await userEvent.click(page.getByRole("button", { name: "Close README.md" }));
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    await act(() => router.navigate(sidebarNavigation(other)));
    await expect.element(composerOf(otherThread)).toBeVisible();
    const from = at(history);

    history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).not.toBe(otherPath));
    expect(at(history)).toBe(from - 1);
    expect(router.state.location.pathname).toBe(ownerPath);
    expect(shownTab()).toBe("chat");
  });

  it("makes a side chat started with /side one stop, as the + menu's is", async () => {
    const starterRef = scopeThreadRef(ENVIRONMENT_ID, starterThread.id);
    using _environment = serve({ acceptCommands: true });
    setup([[starterRef, tabsRecord(["files", "diff"])]]);
    await using app = await openApp([otherPath, pathOf(starterThread)], { thread: starterThread });
    const { history, router } = app;
    const before = at(history);

    await userEvent.click(
      page.getByRole("textbox", { name: `Message ${starterThread.title}`, exact: true }),
    );
    await cdp().send("Input.insertText", { text: "/side hello there" });
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(shownTab(starterRef)).toMatch(/^thread:/), { timeout: 15_000 });
    expect(at(history)).toBe(before + 1);

    history.back();
    await vi.waitFor(() => expect(shownTab(starterRef)).toBe("chat"));
    expect(router.state.location.pathname).toBe(pathOf(starterThread));
  });

  it("makes a web link clicked in a panel tab one stop when it opens a browser tab", async () => {
    using _environment = serve();
    using _browser = offerServerBrowser();
    using _open = answerRpc(WS_METHODS.previewOpen, () =>
      Effect.succeed(previewSnapshot("link-preview")),
    );
    setup([[owner, tabsRecord(["files", "diff"])]], { browserLinkTarget: "app" });
    await using app = await openApp([ownerPath]);
    const { history, router } = app;
    await tap("files");
    const before = at(history);
    // The call a pull request tab's crumb, the Diff tab's commit link or a document's link makes.
    function PanelLink() {
      const openLink = useOpenLink(owner);
      return (
        <button
          type="button"
          onClick={(event) => void openLink("https://example.com/docs", { event })}
        >
          Panel web link
        </button>
      );
    }
    await using _link = await render(
      <AppAtomRegistryProvider>
        <RouterContextProvider router={router}>
          <PanelLink />
        </RouterContextProvider>
      </AppAtomRegistryProvider>,
      { router: false },
    );
    // The app's layout covers this tree's container.
    (page.getByRole("button", { name: "Panel web link" }).element() as HTMLElement).click();
    await vi.waitFor(() => expect(shownTab()).toBe("browser:link-preview"));
    expect(at(history)).toBe(before + 1);

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
  });

  it("makes a pull request check's Details one stop when it opens a browser tab", async () => {
    using _environment = serve();
    using _browser = offerServerBrowser();
    using _open = answerRpc(WS_METHODS.previewOpen, () =>
      Effect.succeed(previewSnapshot("check-details")),
    );
    setup([[owner, tabsRecord(["files"])]], { browserLinkTarget: "app" });
    await using app = await openApp([ownerPath]);
    const { history } = app;
    await tap("files");
    await using checks = await render(
      <AppAtomRegistryProvider>
        <PullRequestChecksPopover
          checksState="failing"
          threadRef={owner}
          checks={[
            {
              name: "Build",
              status: "failure",
              description: null,
              url: "https://example.test/check/1",
            },
          ]}
        />
      </AppAtomRegistryProvider>,
      { router: false },
    );
    const trigger = checks.getByRole("button", { name: /^Checks:/ });
    await expect.element(trigger).toBeVisible();
    (trigger.element() as HTMLElement).click();
    const before = at(history);
    const details = page.getByRole("button", { name: "Details", exact: true });
    await expect.element(details).toBeVisible();
    (details.element() as HTMLElement).click();
    await vi.waitFor(() => expect(shownTab()).toBe("browser:check-details"));
    expect(at(history)).toBe(before + 1);

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
  });

  it("keeps the tab a draft's entry names when the draft becomes its sent thread", async () => {
    using _environment = serve();
    await page.viewport(NARROW.width, NARROW.height);
    setup([[owner, tabsRecord(["files"])]]);
    const draftId = DraftId.make("tab-history-promotion");
    const drafts = useComposerDraftStore.getState();
    drafts.setProjectDraftThreadId(scopeProjectRef(owner.environmentId, PROJECT_ID), draftId, {
      threadId: owner.threadId,
    });
    using _draft = { [Symbol.dispose]: () => drafts.clearDraftThread(draftId) };
    const draftPath = `/draft/${draftId}`;
    const history = createMemoryHistory({ initialEntries: [draftPath] });
    const router = getRouter(history);
    await router.load();
    await using _app = await render(<AppRoot router={router} />, { router: false });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-right-panel-tab-id="files"]')).not.toBeNull(),
    );
    await tap("files");
    expect(readTabTag(history.location.state)?.tab).toBe("files");

    // The server owns the send, so the draft route replaces itself with the thread's.
    await act(() => {
      drafts.markDraftThreadPromoting(draftId, owner);
      drafts.finalizePromotedDraftThread(draftId);
    });
    await vi.waitFor(() => expect(history.location.pathname).toBe(ownerPath));
    expect(readTabTag(history.location.state)?.tab).toBe("files");

    history.back();
    await vi.waitFor(() => expect(shownTab()).toBe("chat"));
    history.forward();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
  });

  it("dedupes a same-URL navigation in a wide window as if its entry had no tag", async () => {
    await page.viewport(WIDE.width, WIDE.height);
    setup([[owner, tabsRecord()]]);
    const navigate = async (tagged: boolean) => {
      const history = createMemoryHistory({ initialEntries: [ownerPath] });
      // A cross-thread Reopen Closed View leaves this state on its destination entry.
      history.replace(ownerPath, {
        reopenedViewId: "closed-view",
        ...(tagged ? tagState(owner, "chat") : {}),
      });
      const router = getRouter(history);
      // With no app mounted, the router follows the history as its Transitioner would.
      using _follow = { [Symbol.dispose]: history.subscribe(() => void router.load()) };
      await router.load();
      using log = historyLog(history);
      await router.navigate(sidebarNavigation(owner));
      return { actions: [...log.actions], reopenedViewId: history.location.state.reopenedViewId };
    };
    const untagged = await navigate(false);
    expect(untagged).toEqual({ actions: ["PUSH"], reopenedViewId: undefined });
    expect(await navigate(true)).toEqual(untagged);
  });

  it("lets the router load a navigation itself again once the last subscriber leaves", async () => {
    await page.viewport(WIDE.width, WIDE.height);
    const history = createMemoryHistory({ initialEntries: ["/issues"] });
    const router = getRouter(history);
    await router.load();
    history.subscribe(() => void router.load())();
    expect(history.subscribers.size).toBe(0);

    let resolved = false;
    void router.navigate({ href: "/pull-requests" }).then(() => (resolved = true));
    await vi.waitFor(() =>
      expect({ resolved, pathname: router.state.location.pathname }).toEqual({
        resolved: true,
        pathname: "/pull-requests",
      }),
    );
  });

  it("joins the next subscriber first, and measures its first pop from where the history is then", async () => {
    await page.viewport(NARROW.width, NARROW.height);
    setup([[owner, tabsRecord()]]);
    const history = createMemoryHistory({
      initialEntries: [ownerPath, ownerPath],
      initialIndex: 1,
    });
    history.replace(ownerPath, tagState(owner, "files"));
    history.back();
    history.replace(ownerPath, tagState(owner, "chat"));
    history.forward();
    const router = getRouter(history);
    history.subscribe(() => void router.load())();
    // A Back while nothing listens, which tab history does not hear.
    history.back();
    const heard: Array<readonly [string, boolean]> = [];
    using _follow = {
      [Symbol.dispose]: history.subscribe(({ action, location }) => {
        heard.push([action.type, isTabHistoryWrite(location)]);
        void router.load();
      }),
    };
    await router.load();

    history.forward();
    await vi.waitFor(() => expect(shownTab()).toBe("files"));
    userTabMove(owner, () =>
      useRightPanelStore
        .getState()
        .updateWorkArea(owner, { type: "activate", tab: asTabId("diff") }),
    );
    expect(heard).toEqual([
      ["FORWARD", false],
      ["PUSH", true],
    ]);
  });
});

const filesRow = (path: string) => {
  // The tree draws its rows in a shadow root.
  for (const host of document.querySelectorAll("*")) {
    const item = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (item) return item;
  }
  return null;
};

async function closeSettings(app: Awaited<ReturnType<typeof openApp>>) {
  await act(() => app.router.navigate({ to: "/settings/general" }));
  await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(app.router.state.location.pathname).toBe(ownerPath));
  await expect.element(page.getByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
}
