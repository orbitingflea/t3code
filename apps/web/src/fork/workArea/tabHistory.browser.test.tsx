import "~/index.css";

import { createBrowserHistory, RouterContextProvider } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type PreviewSessionSnapshot,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { useClosedViewStore } from "~/closedViewStore";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { startMainAppLocationTracking } from "~/components/sidebar/mainAppLocation";
import { useThreadActions } from "~/hooks/useThreadActions";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { assistantCitationNavigation } from "~/lib/assistantCitationNavigation";
import { getRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import {
  answerRpc,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { tabHistoryTags } from "./tabHistoryTags";
import { asTabId, focusedTab, resolveLayout } from "./workArea.logic";
import { restoredRecord, restoreWorkArea } from "./workAreaStorage.logic";
import { currentWorkAreaView } from "./workAreaView";

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

const ownerThread = threadWithHistory("owner", 1);
const otherThread = threadWithHistory("other", 1);
const sideThread = { ...threadWithHistory("side", 1), sideChatOf: ownerThread.id };
// The real server always serves thread families; the fake does when a thread is older settled.
const settledThread = { ...threadWithHistory("settled", 1), olderSettled: true as const };
// Each is deleted by one test only, so no earlier test leaves a command waiting on its thread.
const doomedThread = threadWithHistory("doomed", 1);
const doomedOnBackThread = threadWithHistory("doomed-on-back", 1);
const doomedParentThread = threadWithHistory("doomed-parent", 1);
const doomedKidThread = {
  ...threadWithHistory("doomed-kid", 1),
  sideChatOf: doomedParentThread.id,
};
// The app keeps the first test's shell and server config for the whole file, so every test serves
// the same threads.
const THREADS = [
  ownerThread,
  otherThread,
  sideThread,
  settledThread,
  doomedThread,
  doomedOnBackThread,
  doomedParentThread,
  doomedKidThread,
];
const threadPath = (thread: (typeof THREADS)[number]) => `/${ENVIRONMENT_ID}/${thread.id}`;
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);
const other = scopeThreadRef(ENVIRONMENT_ID, otherThread.id);
const settled = scopeThreadRef(ENVIRONMENT_ID, settledThread.id);
const doomed = scopeThreadRef(ENVIRONMENT_ID, doomedThread.id);
const doomedOnBack = scopeThreadRef(ENVIRONMENT_ID, doomedOnBackThread.id);
const doomedParent = scopeThreadRef(ENVIRONMENT_ID, doomedParentThread.id);
const doomedKid = scopeThreadRef(ENVIRONMENT_ID, doomedKidThread.id);
const OWNER_PATH = threadPath(ownerThread);
const OTHER_PATH = threadPath(otherThread);
const SETTLED_PATH = threadPath(settledThread);
const deleted = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("deleted"));
const SIDE_TAB = `thread:${sideThread.id}`;

function setup(thread = owner) {
  useRightPanelStore.setState({
    byThreadKey: {
      [scopedThreadKey(thread)]: restoredRecord({
        isOpen: false,
        activeSurfaceId: null,
        surfaces: [
          { id: "files", kind: "files" },
          { id: "diff", kind: "diff" },
        ],
        workArea: restoreWorkArea({
          root: { kind: "pane", id: "p0", tabs: ["chat", "files", "diff"], active: "chat" },
          tabs: {
            chat: { kind: "primary-chat" },
            files: { kind: "surface" },
            diff: { kind: "surface" },
          },
          focused: "p0",
          seq: 1,
        })!,
      }),
    },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
}

// Gives every listed thread the same Chat, Files and Diff layout.
function setupMany(...threads: (typeof owner)[]) {
  setup(threads[0]);
  const first = useRightPanelStore.getState().byThreadKey[scopedThreadKey(threads[0]!)]!;
  useRightPanelStore.setState({
    byThreadKey: Object.fromEntries(threads.map((thread) => [scopedThreadKey(thread), first])),
  });
}

const shownTabOf = (thread: typeof owner) =>
  focusedTab(resolveLayout(useRightPanelStore.getState().byThreadKey[scopedThreadKey(thread)]!));
const shownTab = () => shownTabOf(owner);

// Opens the owner over an entry of the other thread, so Back never leaves the test page.
async function openOwner(
  width: number,
  options: {
    readonly deletedEntries?: number;
    readonly thread?: typeof ownerThread;
    // Leaves the browser entries for the caller to reset, so a new app can start on them.
    readonly keepBrowserEntries?: boolean;
  } = {},
) {
  const thread = options.thread ?? ownerThread;
  await page.viewport(width, 900);
  const startHref = window.location.href;
  window.history.pushState(null, "", OTHER_PATH);
  const history = createBrowserHistory();
  // Entries recorded in narrow mode on a thread that is deleted later.
  for (const [index, tab] of ["chat", "files", "diff"]
    .slice(0, options.deletedEntries ?? 0)
    .entries()) {
    history.push(`/${deleted.environmentId}/${deleted.threadId}`);
    history.flush();
    tabHistoryTags.set(history.location.state, {
      thread: scopedThreadKey(deleted),
      tab: asTabId(tab),
      ...(index > 0 ? { pushed: true } : {}),
    });
  }
  history.push(`/${ENVIRONMENT_ID}/${thread.id}`);
  history.flush();
  const router = getRouter(history);
  await router.load();
  await using stack = new AsyncDisposableStack();
  stack.defer(() => {
    history.destroy();
    if (!options.keepBrowserEntries) window.history.replaceState(null, "", startHref);
  });
  // AppRoot brings its own router.
  stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect.element(composer(thread)).toBeVisible();
  const opened = stack.move();
  return { router, [Symbol.asyncDispose]: () => opened.disposeAsync() };
}

// As the delete flow does for a deleted thread.
const markDeleted = () => tabHistoryTags.markDead(scopedThreadKey(deleted));

// The real delete flow, run from a button beside the app, with the delete command held. Install it
// before the thread opens: the app sends commands then, and one left unanswered holds the later
// commands on its thread.
function holdDelete(target: typeof owner) {
  const reply = Promise.withResolvers<void>();
  let sent = false;
  const dispatch = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    (command: OrchestrationV2Command) => {
      if (command.type !== "thread.delete") return Effect.succeed({ sequence: 1 });
      sent = true;
      return Effect.promise(() => reply.promise).pipe(Effect.as({ sequence: 1 }));
    },
  );
  // Stopping the thread's session first reads its provider sessions.
  const projection = answerRpc(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, () =>
    Effect.succeed({ providerSessions: [] }),
  );
  const results: ReturnType<ReturnType<typeof useThreadActions>["deleteThread"]>[] = [];
  function DeleteButton() {
    const { deleteThread } = useThreadActions();
    return (
      <button type="button" onClick={() => results.push(deleteThread(target))}>
        Delete thread
      </button>
    );
  }
  return {
    render: (router: ReturnType<typeof getRouter>) =>
      render(
        <AppAtomRegistryProvider>
          <RouterContextProvider router={router}>
            <DeleteButton />
          </RouterContextProvider>
        </AppAtomRegistryProvider>,
        { router: false },
      ),
    start: async () => {
      // The app covers this button, so the click goes to the element itself.
      page
        .getByRole("button", { name: "Delete thread" })
        .element()
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await expect.poll(() => sent).toBe(true);
    },
    finish: async () => {
      reply.resolve();
      return (await results[0])?._tag;
    },
    [Symbol.dispose]: () => {
      dispatch[Symbol.dispose]();
      projection[Symbol.dispose]();
    },
  };
}

// Reopen Closed View of the other thread's browser tab, with the browser restore held.
function holdBrowserReopen() {
  const closedBrowser: PreviewSessionSnapshot = {
    threadId: other.threadId,
    tabId: "closed-tab",
    navStatus: { _tag: "Idle" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-11-24T00:00:00Z",
  };
  const response = Promise.withResolvers<PreviewSessionSnapshot>();
  let requested = false;
  const preview = answerRpc(WS_METHODS.previewOpen, () => {
    requested = true;
    return Effect.promise(() => response.promise);
  });
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  return {
    remember: () =>
      useClosedViewStore
        .getState()
        .remember({ kind: "browser", threadRef: other, snapshot: closedBrowser }),
    requested: () => requested,
    restore: () => response.resolve({ ...closedBrowser, tabId: "restored-tab" }),
    // The reopen removes its entry right before it decides whether to follow the restore.
    settled: async () => {
      await expect
        .poll(() =>
          useRightPanelStore
            .getState()
            .byThreadKey[scopedThreadKey(other)]?.surfaces.some(
              (surface) => surface.id === "browser:restored-tab",
            ),
        )
        .toBe(true);
      await expect.poll(() => useClosedViewStore.getState().entries.length).toBe(0);
    },
    [Symbol.dispose]: () => {
      preview[Symbol.dispose]();
      platform.mockRestore();
    },
  };
}

const composer = (thread: typeof ownerThread) =>
  page.getByRole("textbox", { name: `Message ${thread.title}` });
const modalClose = (dialog: "Settings" | "Usage") =>
  page.getByRole("dialog", { name: dialog }).getByRole("button", {
    name: "Close",
    exact: true,
  });
const settingsClose = () => modalClose("Settings");
const pressTab = (tab: string) =>
  userEvent.click(
    page.elementLocator(document.querySelector(`[data-right-panel-tab-id="${tab}"]`)!),
  );
const historyIndex = () => (window.history.state as { __TSR_index: number }).__TSR_index;
const quoted = () => window.location.hash.startsWith("#assistant-citation=");
const pressReopen = () => {
  const key = new KeyboardEvent("keydown", {
    key: "T",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(true);
};

const quoteFor = (
  thread: typeof ownerThread,
  source: Parameters<typeof assistantCitationNavigation>[1] = null,
) =>
  assistantCitationNavigation(
    {
      version: 1,
      environmentId: ENVIRONMENT_ID,
      threadId: thread.id,
      messageId: MessageId.make(`${thread.id}-assistant-0`),
      text: "Answer",
      start: 0,
      end: 6,
      prefix: "",
      suffix: "",
    },
    source,
  );

const snapshot = () => ({
  path: window.location.pathname,
  index: historyIndex(),
  tab: shownTab(),
  quote: quoted(),
  tag: tabHistoryTags.get(window.history.state)?.tab ?? null,
});

describe("tab history", () => {
  it.each([false, true])(
    "wide Back from a second thread restores the quote URL with narrow tab push %s",
    async (pushTab) => {
      using _environment = installFakeEnvironment(THREADS);
      setup();
      await using app = await openOwner(800);
      await app.router.navigate(quoteFor(ownerThread));
      await expect.poll(snapshot).toMatchObject({ path: OWNER_PATH, index: 2, quote: true });
      if (pushTab) {
        await pressTab("files");
        await expect.poll(snapshot).toMatchObject({ index: 3, quote: false, tab: "files" });
      }
      await app.router.navigate({ href: OTHER_PATH });
      await expect.element(composer(otherThread)).toBeVisible();
      await page.viewport(1400, 900);
      await expect.poll(() => currentWorkAreaView().narrow).toBe(false);

      const at = () => ({ path: window.location.pathname, index: historyIndex(), quote: quoted() });
      window.history.back();
      await expect.poll(at).toEqual({ path: OWNER_PATH, index: 2, quote: true });
      window.history.back();
      await expect.poll(at).toEqual({ path: OWNER_PATH, index: 1, quote: false });
    },
  );

  it("Back passes three entries of a deleted thread on a server with thread families", async () => {
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using app = await openOwner(800, { deletedEntries: 3 });
    await expect
      .poll(
        () =>
          appAtomRegistry.get(serverEnvironment.configValueAtom(ENVIRONMENT_ID))
            ?.shellThreadFamilies,
      )
      .toBe(true);
    markDeleted();
    expect(historyIndex()).toBe(4);

    window.history.back();
    await expect.element(composer(otherThread)).toBeVisible();
    expect([historyIndex(), app.router.state.location.pathname]).toEqual([0, OTHER_PATH]);
  });

  it("Back passes a deleted thread's entries with no work area mounted", async () => {
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using app = await openOwner(800, { deletedEntries: 3 });
    await app.router.navigate({ to: "/workflows", replace: true });
    await expect.element(composer(ownerThread)).not.toBeInTheDocument();
    markDeleted();

    window.history.back();
    await expect.element(composer(otherThread)).toBeVisible();
    expect([historyIndex(), app.router.state.location.pathname]).toEqual([0, OTHER_PATH]);
  });

  it("steps Back through narrow tab presses, skips a closed tab, then leaves the thread", async () => {
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using app = await openOwner(800);

    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);
    await pressTab("diff");
    await expect.poll(historyIndex).toBe(3);

    window.history.back();
    await expect.poll(shownTab).toBe("files");
    window.history.forward();
    await expect.poll(shownTab).toBe("diff");

    useRightPanelStore.getState().closeSurface(owner, "files");
    window.history.back();
    await expect.poll(shownTab).toBe("chat");
    expect(historyIndex()).toBe(1);
    expect(tabHistoryTags.get(window.history.state)).toEqual({
      thread: scopedThreadKey(owner),
      tab: "chat",
    });

    window.history.back();
    await expect.element(composer(otherThread)).toBeVisible();
    expect(app.router.state.location.pathname).toBe(OTHER_PATH);
  });

  it("pushes nothing for desktop tab presses, so Back leaves the thread", async () => {
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using app = await openOwner(1400);
    const length = window.history.length;

    await pressTab("files");
    await expect.poll(shownTab).toBe("files");
    await pressTab("diff");
    await expect.poll(shownTab).toBe("diff");
    await pressTab("chat");
    await expect.poll(shownTab).toBe("chat");
    expect(historyIndex()).toBe(1);

    window.history.back();
    await expect.element(composer(otherThread)).toBeVisible();
    expect(app.router.state.location.pathname).toBe(OTHER_PATH);
    expect([historyIndex(), window.history.length]).toEqual([0, length]);
  });

  it("wide Back crosses the entries narrow tab presses left", async () => {
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using _app = await openOwner(800);
    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);
    await pressTab("diff");
    await expect.poll(historyIndex).toBe(3);
    await page.viewport(1400, 900);
    await expect.poll(() => currentWorkAreaView().narrow).toBe(false);

    window.history.back();
    await expect.poll(() => window.location.pathname).toBe(OTHER_PATH);
  });

  it("wide Back crosses tab entries pushed from a quote entry", async () => {
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using app = await openOwner(800);
    await app.router.navigate({ ...quoteFor(ownerThread), replace: true });
    expect(snapshot()).toMatchObject({ index: 1, quote: true, tab: "chat" });
    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);
    await pressTab("diff");
    await expect.poll(historyIndex).toBe(3);
    await page.viewport(1400, 900);
    await expect.poll(() => currentWorkAreaView().narrow).toBe(false);

    window.history.back();
    await expect.poll(() => window.location.pathname).toBe(OTHER_PATH);
    expect(historyIndex()).toBe(0);
  });

  it("keeps narrow Back and Forward tab stops after clicking Settings Close", async () => {
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using app = await openOwner(800);
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(app.router) };
    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);
    await pressTab("diff");
    await expect.poll(historyIndex).toBe(3);
    const length = window.history.length;
    await app.router.navigate({ href: "/settings/general" });
    const close = settingsClose();
    await expect.element(close).toBeVisible();
    await userEvent.click(close);
    await expect.element(close).not.toBeInTheDocument();
    await expect.poll(snapshot).toMatchObject({ path: OWNER_PATH, index: 3, tab: "diff" });
    // Settings left Forward history: the entry count is back to what it was before it opened.
    expect(window.history.length).toBe(length);

    window.history.back();
    await expect.poll(snapshot).toMatchObject({ path: OWNER_PATH, index: 2, tab: "files" });
    window.history.forward();
    await expect.poll(snapshot).toMatchObject({ path: OWNER_PATH, index: 3, tab: "diff" });
  });

  it("pushes tab presses made on a main-chat quote, and Back steps through the quote", async () => {
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using app = await openOwner(800);
    await app.router.navigate(quoteFor(ownerThread));
    await expect.poll(quoted).toBe(true);
    expect(historyIndex()).toBe(2);

    await pressTab("files");
    await expect.poll(historyIndex).toBe(3);
    await pressTab("diff");
    await expect.poll(historyIndex).toBe(4);
    expect(quoted()).toBe(false);

    window.history.back();
    await expect.poll(shownTab).toBe("files");
    window.history.back();
    await expect.poll(shownTab).toBe("chat");
    expect([historyIndex(), quoted()]).toEqual([2, true]);

    // Back from the quote stays on this thread: Forward from there reaches the quote again.
    window.history.back();
    await expect.poll(historyIndex).toBe(1);
    window.history.forward();
    await expect.poll(historyIndex).toBe(2);
    expect([shownTab(), quoted(), app.router.state.location.pathname]).toEqual([
      "chat",
      true,
      OWNER_PATH,
    ]);
  });

  it("records a manual narrow switch to the side-chat tab named by the current quote", async () => {
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using app = await openOwner(1400);
    const shell = readThreadShell(scopeThreadRef(ENVIRONMENT_ID, sideThread.id));
    expect(shell?.lineage.parentThreadId).toBe(ownerThread.id);
    await app.router.navigate({ ...quoteFor(sideThread, shell), replace: true });
    await expect.poll(shownTab).toBe(SIDE_TAB);
    await pressTab("files");
    await expect.poll(shownTab).toBe("files");
    expect(snapshot()).toMatchObject({ index: 1, quote: true });
    await page.viewport(800, 900);
    await expect.poll(() => snapshot().tag).toBe("files");

    await pressTab(SIDE_TAB);
    await expect.poll(historyIndex).toBe(2);
    // Back stays on the thread, at the quote entry, where the quote shows its side chat again.
    window.history.back();
    await expect
      .poll(snapshot)
      .toMatchObject({ path: OWNER_PATH, index: 1, tab: SIDE_TAB, quote: true });
  });

  it("Back onto a side-chat quote whose tab was closed lets the quote show it again", async () => {
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using app = await openOwner(800);
    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);
    const shell = readThreadShell(scopeThreadRef(ENVIRONMENT_ID, sideThread.id));
    expect(shell?.lineage.parentThreadId).toBe(ownerThread.id);
    await app.router.navigate(quoteFor(sideThread, shell));
    await expect.poll(shownTab).toBe(SIDE_TAB);
    await expect.poll(() => snapshot().tag).toBe(SIDE_TAB);
    expect(historyIndex()).toBe(3);
    await pressTab("diff");
    await expect.poll(historyIndex).toBe(4);
    useRightPanelStore.getState().closeSurface(owner, SIDE_TAB);

    // The quote's own reveal shows its side chat again and records it on the quote entry.
    window.history.back();
    await expect
      .poll(snapshot)
      .toMatchObject({ path: OWNER_PATH, index: 3, quote: true, tab: SIDE_TAB, tag: SIDE_TAB });
  });

  it("puts a same-thread Reopen Closed View on the narrow Back stack", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using _app = await openOwner(800);
    useRightPanelStore.getState().closeSurface(owner, "diff");
    useClosedViewStore.setState({ entries: [] });
    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);
    useClosedViewStore.getState().remember({
      kind: "panel-tab",
      threadRef: owner,
      surface: { id: "diff", kind: "diff" },
    });

    pressReopen();
    await expect.poll(shownTab).toBe("diff");
    await expect.poll(historyIndex).toBe(3);
    window.history.back();
    await expect.poll(snapshot).toMatchObject({ path: OWNER_PATH, index: 2, tab: "files" });
    expect(
      useRightPanelStore
        .getState()
        .byThreadKey[scopedThreadKey(owner)]?.surfaces.some((surface) => surface.id === "diff"),
    ).toBe(true);
  });

  it("Back after a narrow Reopen Closed View returns to the tab shown before it", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using app = await openOwner(800);
    useRightPanelStore.getState().closeSurface(owner, "diff");
    useClosedViewStore.setState({ entries: [] });
    useClosedViewStore.getState().remember({
      kind: "panel-tab",
      threadRef: owner,
      surface: { id: "diff", kind: "diff" },
    });
    expect([shownTab(), historyIndex()]).toEqual(["chat", 1]);

    pressReopen();
    await expect.poll(shownTab).toBe("diff");
    await expect.poll(historyIndex).toBe(2);
    window.history.back();
    await expect.poll(shownTab).toBe("chat");
    expect([historyIndex(), app.router.state.location.pathname]).toEqual([1, OWNER_PATH]);
  });

  it.each([1400, 800])(
    "lets a queued reopen follow its browser restore to the other thread at width %i",
    async (width) => {
      using _environment = installFakeEnvironment(THREADS);
      using reopen = holdBrowserReopen();
      setup();
      await using app = await openOwner(width);
      useRightPanelStore.getState().closeSurface(owner, "diff");
      useClosedViewStore.setState({ entries: [] });
      reopen.remember();
      useClosedViewStore.getState().remember({
        kind: "panel-tab",
        threadRef: owner,
        surface: { id: "diff", kind: "diff" },
      });

      // Reopen Closed View twice: Diff here first, then the other thread's browser tab.
      pressReopen();
      pressReopen();
      await expect.poll(reopen.requested).toBe(true);
      await expect.poll(shownTab).toBe("diff");
      // Narrow mode records the reopened Diff tab as a tab entry.
      await expect.poll(historyIndex).toBe(width === 800 ? 2 : 1);

      reopen.restore();
      await reopen.settled();
      expect(app.router.history.location.pathname).toBe(OTHER_PATH);
    },
  );

  it.each([1, 2])(
    "keeps a user's Back to entry %i while a Reopen Closed View request is pending",
    async (destinationIndex) => {
      using _environment = installFakeEnvironment(THREADS);
      using reopen = holdBrowserReopen();
      setup();
      await using app = await openOwner(800);
      await pressTab("files");
      await expect.poll(historyIndex).toBe(2);
      if (destinationIndex === 2) {
        await pressTab("diff");
        await expect.poll(historyIndex).toBe(3);
      }
      useClosedViewStore.setState({ entries: [] });
      reopen.remember();
      pressReopen();
      await expect.poll(reopen.requested).toBe(true);

      window.history.back();
      const tab = destinationIndex === 2 ? "files" : "chat";
      await expect.poll(snapshot).toMatchObject({ path: OWNER_PATH, index: destinationIndex, tab });
      reopen.restore();
      await reopen.settled();
      expect({
        pathname: app.router.history.location.pathname,
        index: app.router.history.location.state.__TSR_index,
        tab: shownTab(),
      }).toEqual({ pathname: OWNER_PATH, index: destinationIndex, tab });
    },
  );

  it.each([false, true])(
    "lets a thread switch win over a pending reopen, with a tab press after the switch: %s",
    async (pressAfterSwitch) => {
      using _environment = installFakeEnvironment(THREADS);
      using reopen = holdBrowserReopen();
      setupMany(owner, settled);
      await using app = await openOwner(800);
      useClosedViewStore.setState({ entries: [] });
      reopen.remember();

      pressReopen();
      await expect.poll(reopen.requested).toBe(true);
      await app.router.navigate({ href: SETTLED_PATH });
      await expect.element(composer(settledThread)).toBeVisible();
      expect(historyIndex()).toBe(2);
      if (pressAfterSwitch) {
        await pressTab("files");
        await expect.poll(historyIndex).toBe(3);
      }

      reopen.restore();
      await reopen.settled();
      expect(app.router.history.location.pathname).toBe(SETTLED_PATH);
    },
  );

  it.each([800, 1400])(
    "lets Settings open and Close win over a pending reopen at width %i",
    async (width) => {
      using _environment = installFakeEnvironment(THREADS);
      using reopen = holdBrowserReopen();
      setup();
      await using app = await openOwner(width);
      using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(app.router) };
      await pressTab("files");
      await expect.poll(shownTab).toBe("files");
      useClosedViewStore.setState({ entries: [] });
      reopen.remember();
      pressReopen();
      await expect.poll(reopen.requested).toBe(true);
      await app.router.navigate({ href: "/settings/general" });
      const close = settingsClose();
      await expect.element(close).toBeVisible();
      await userEvent.click(close);
      await expect.element(close).not.toBeInTheDocument();
      await expect.poll(snapshot).toMatchObject({ path: OWNER_PATH, tab: "files" });

      reopen.restore();
      await reopen.settled();
      expect(app.router.history.location.pathname).toBe(OWNER_PATH);
    },
  );

  it("records a tab press even if a non-user reveal runs before the history write", async () => {
    using _environment = installFakeEnvironment(THREADS);
    setup();
    await using _app = await openOwner(800);
    const observations: string[] = [];
    const stop = useRightPanelStore.subscribe(() => {
      if (shownTab() !== "files") return;
      stop();
      queueMicrotask(() => {
        observations.push(shownTab());
        useRightPanelStore.getState().revealSurface(owner, "diff");
        observations.push(shownTab());
      });
    });

    try {
      await pressTab("files");
    } finally {
      stop();
    }
    await expect.poll(historyIndex).toBe(2);
    expect({ observations, ...snapshot() }).toMatchObject({
      observations: ["files", "diff"],
      tab: "diff",
      tag: "files",
    });
    window.history.back();
    await expect.poll(shownTab).toBe("chat");
    window.history.forward();
    await expect.poll(historyIndex).toBe(2);
    await expect.poll(shownTab).toBe("files");
  });

  it("still opens the next thread when a tab press lands while the shown thread is deleted", async () => {
    using _environment = installFakeEnvironment(THREADS);
    using deletion = holdDelete(doomed);
    setup(doomed);
    await using app = await openOwner(800, { thread: doomedThread });
    await using _button = await deletion.render(app.router);

    await deletion.start();
    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);
    expect(shownTabOf(doomed)).toBe("files");
    expect(await deletion.finish()).toBe("Success");

    // The delete's fallback replaces the tab entry with the next thread.
    await expect.poll(() => app.router.state.location.pathname).not.toBe(threadPath(doomedThread));
    expect(THREADS.map(threadPath)).toContain(app.router.state.location.pathname);
    expect(historyIndex()).toBe(2);
  });

  it("still opens the next thread when a narrow Back lands while the shown thread is deleted", async () => {
    using _environment = installFakeEnvironment(THREADS);
    using deletion = holdDelete(doomedOnBack);
    setup(doomedOnBack);
    await using app = await openOwner(800, { thread: doomedOnBackThread });
    await using _button = await deletion.render(app.router);
    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);

    await deletion.start();
    // In narrow mode, Back is a tab step inside the thread, like a tab press.
    window.history.back();
    await expect.poll(() => shownTabOf(doomedOnBack)).toBe("chat");
    expect([historyIndex(), app.router.state.location.pathname]).toEqual([
      1,
      threadPath(doomedOnBackThread),
    ]);
    expect(await deletion.finish()).toBe("Success");

    await expect
      .poll(() => app.router.state.location.pathname)
      .not.toBe(threadPath(doomedOnBackThread));
    expect(THREADS.map(threadPath)).toContain(app.router.state.location.pathname);
  });

  it("Back passes a deleted thread's saved tab entries after a reload", async () => {
    using _environment = installFakeEnvironment(THREADS);
    using deletion = holdDelete(deleted);
    setup(deleted);
    // As after a reload: the panel record and the entries' tags remain, the revision counts do not.
    useRightPanelStore.setState({
      userActionRevisionByThreadKey: {},
      closeRevisionByThreadKey: {},
    });
    await using app = await openOwner(800, { deletedEntries: 3 });
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(deleted)]).toBeDefined();
    expect(historyIndex()).toBe(4);
    await using _button = await deletion.render(app.router);
    await deletion.start();
    expect(await deletion.finish()).toBe("Success");
    expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(deleted)]).toBeUndefined();

    window.history.back();
    await expect
      .poll(() => [historyIndex(), app.router.history.location.pathname])
      .toEqual([0, OTHER_PATH]);
  });

  it.each([false, true])(
    "wide Back from Workflows reaches the quote entry, with the app mounted fresh on Workflows: %s",
    async (fresh) => {
      using _environment = installFakeEnvironment(THREADS);
      setup();
      const startHref = window.location.href;
      await using stack = new AsyncDisposableStack();
      stack.defer(() => window.history.replaceState(null, "", startHref));
      const app = stack.use(await openOwner(800, { keepBrowserEntries: true }));
      await app.router.navigate(quoteFor(ownerThread));
      await expect.poll(snapshot).toMatchObject({ index: 2, quote: true });
      await pressTab("files");
      await expect.poll(snapshot).toMatchObject({ index: 3, quote: false, tab: "files" });
      await app.router.navigate({ href: "/workflows" });
      await expect.element(composer(ownerThread)).not.toBeInTheDocument();
      await page.viewport(1400, 900);
      expect(historyIndex()).toBe(4);
      if (fresh) {
        // As after a reload: a new router and app over the same browser entries and saved tags,
        // with no work area mounted.
        await app[Symbol.asyncDispose]();
        const history = createBrowserHistory();
        stack.defer(() => history.destroy());
        const router = getRouter(history);
        await router.load();
        stack.use(await render(<AppRoot router={router} />, { router: false }));
        expect(router.state.location.pathname).toBe("/workflows");
      }

      window.history.back();
      await expect.poll(snapshot).toMatchObject({ path: OWNER_PATH, index: 2, quote: true });
    },
  );

  it.each([OTHER_PATH, "/settings/general"])(
    "keeps Forward history after a Back-menu jump from %s to an earlier tab entry",
    async (startPath) => {
      using _environment = installFakeEnvironment(THREADS);
      setup();
      await using app = await openOwner(800);
      using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(app.router) };
      await pressTab("files");
      await expect.poll(historyIndex).toBe(2);
      await pressTab("diff");
      await expect.poll(historyIndex).toBe(3);
      await app.router.navigate({ href: startPath });
      await expect.poll(() => app.router.state.location.pathname).toBe(startPath);
      expect(historyIndex()).toBe(4);

      // A pick two entries back in the browser's Back menu is one native jump.
      window.history.go(-2);
      await expect.poll(snapshot).toMatchObject({ path: OWNER_PATH, index: 2, tag: "files" });
      window.history.go(2);
      await expect.poll(() => [window.location.pathname, historyIndex()]).toEqual([startPath, 4]);
    },
  );

  it.each([
    { presses: 0, modal: "/settings/general", dialog: "Settings" },
    { presses: 1, modal: "/settings/general", dialog: "Settings" },
    { presses: 2, modal: "/settings/general", dialog: "Settings" },
    { presses: 1, modal: "/usage", dialog: "Usage" },
  ] as const)(
    "drops $modal from Forward when its Close runs in a wide window after $presses narrow tab presses",
    async ({ presses, modal, dialog }) => {
      using _environment = installFakeEnvironment(THREADS);
      setup();
      await using app = await openOwner(presses === 0 ? 1400 : 800);
      using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(app.router) };
      if (presses >= 1) {
        await pressTab("files");
        await expect.poll(historyIndex).toBe(2);
      }
      if (presses >= 2) {
        await pressTab("diff");
        await expect.poll(historyIndex).toBe(3);
        window.history.back();
        await expect.poll(snapshot).toMatchObject({ index: 2, tab: "files" });
      }
      await page.viewport(1400, 900);
      await expect.poll(() => currentWorkAreaView().narrow).toBe(false);
      const tab = shownTab();
      await app.router.navigate({ href: modal });
      const close = modalClose(dialog);
      await expect.element(close).toBeVisible();
      await userEvent.click(close);
      await expect.element(close).not.toBeInTheDocument();

      // With nothing ahead, Forward stays on the thread.
      await expect
        .poll(() => ({ path: window.location.pathname, forward: navigation.canGoForward }))
        .toEqual({ path: OWNER_PATH, forward: false });
      expect(shownTab()).toBe(tab);
    },
  );

  it("Back passes a side chat's tab entries after its parent thread is deleted", async () => {
    using _environment = installFakeEnvironment(THREADS);
    using deletion = holdDelete(doomedParent);
    setupMany(doomedKid, owner);
    await using app = await openOwner(800, { thread: doomedKidThread });
    await using _button = await deletion.render(app.router);
    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);
    await pressTab("diff");
    await expect.poll(historyIndex).toBe(3);
    await app.router.navigate({ href: OWNER_PATH });
    await expect.element(composer(ownerThread)).toBeVisible();
    expect(historyIndex()).toBe(4);
    expect(readThreadShell(doomedKid)?.lineage.parentThreadId).toBe(doomedParentThread.id);

    // The server deletes the side chat with its parent.
    await deletion.start();
    expect(await deletion.finish()).toBe("Success");

    window.history.back();
    await expect.poll(() => [historyIndex(), window.location.pathname]).toEqual([0, OTHER_PATH]);
  });
});
