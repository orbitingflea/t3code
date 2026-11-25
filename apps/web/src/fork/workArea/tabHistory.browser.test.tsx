import "~/index.css";

import { createBrowserHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import {
  closeThreadFind,
  openThreadFind,
  useThreadFindStore,
} from "~/components/chat/threadFindStore";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { focusedTab, resolveLayout } from "./workArea.logic";
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

const ownerThread = threadWithHistory("owner", 1);
const otherThread = threadWithHistory("other", 1);
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);
const OWNER_PATH = `/${ENVIRONMENT_ID}/${ownerThread.id}`;
const OTHER_PATH = `/${ENVIRONMENT_ID}/${otherThread.id}`;
const ISSUES = "/issues";
// Every test offers Find: the Find test times out after tests whose server config lacks it.
const installEnvironment = () =>
  installFakeEnvironment([ownerThread, otherThread], { threadFind: true });

function setup(active: "chat" | "files" = "chat") {
  useRightPanelStore.setState({
    byThreadKey: {
      [scopedThreadKey(owner)]: restoredRecord({
        isOpen: false,
        activeSurfaceId: null,
        surfaces: [
          { id: "files", kind: "files" },
          { id: "diff", kind: "diff" },
        ],
        workArea: restoreWorkArea({
          root: { kind: "pane", id: "p0", tabs: ["chat", "files", "diff"], active },
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

const shownTab = () =>
  focusedTab(resolveLayout(useRightPanelStore.getState().byThreadKey[scopedThreadKey(owner)]!));

// Opens the owner over an entry of another page, so Back never leaves the test page.
async function openOwner(width: number, under = OTHER_PATH) {
  await page.viewport(width, 900);
  const startHref = window.location.href;
  window.history.pushState(null, "", under);
  const history = createBrowserHistory();
  history.push(OWNER_PATH);
  history.flush();
  const router = getRouter(history);
  await router.load();
  await using stack = new AsyncDisposableStack();
  stack.defer(() => {
    history.destroy();
    window.history.replaceState(null, "", startHref);
  });
  // AppRoot brings its own router.
  stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect.element(composer(ownerThread)).toBeVisible();
  const opened = stack.move();
  return { router, [Symbol.asyncDispose]: () => opened.disposeAsync() };
}

const composer = (thread: typeof ownerThread) =>
  page.getByRole("textbox", { name: `Message ${thread.title}` });
const tabElement = (tab: string) => document.querySelector(`[data-right-panel-tab-id="${tab}"]`)!;
const pressTab = (tab: string) => userEvent.click(page.elementLocator(tabElement(tab)));
const ownerGone = () => expect.poll(() => composer(ownerThread).query()).toBeNull();
// The history steps taken so far, read once no step came between two checks.
async function quietSteps(steps: { readonly mock: { readonly calls: readonly unknown[] } }) {
  let seen = -1;
  await vi.waitFor(() => {
    const now = steps.mock.calls.length;
    const settled = now === seen;
    seen = now;
    expect(settled).toBe(true);
  });
  return seen;
}
const historyIndex = () => (window.history.state as { __TSR_index: number }).__TSR_index;
const entry = () => ({
  pathname: window.location.pathname,
  index: historyIndex(),
  tag: window.history.state.workAreaTab?.tab,
});

describe("tab history", () => {
  it("steps Back and Forward through narrow tab presses, skips a closed tab, then leaves", async () => {
    using _environment = installEnvironment();
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
    window.history.back();
    await expect.poll(shownTab).toBe("files");
    window.history.back();
    await expect.poll(shownTab).toBe("chat");
    expect(entry()).toEqual({ pathname: OWNER_PATH, index: 1, tag: "chat" });

    useRightPanelStore.getState().closeSurface(owner, "files");
    window.history.forward();
    await expect.poll(entry).toEqual({ pathname: OWNER_PATH, index: 3, tag: "diff" });
    expect(shownTab()).toBe("diff");
    window.history.back();
    await expect.poll(entry).toEqual({ pathname: OWNER_PATH, index: 1, tag: "chat" });
    expect(shownTab()).toBe("chat");

    window.history.back();
    await expect.element(composer(otherThread)).toBeVisible();
    expect(app.router.state.location.pathname).toBe(OTHER_PATH);
  });

  it("pushes a tab entry without the quote hash and leaves the quote entry untagged", async () => {
    using _environment = installEnvironment();
    setup();
    await using app = await openOwner(800);
    // A malformed quote reveals nothing, so only the tab history acts on this entry.
    app.router.history.push(`${OWNER_PATH}#assistant-citation=x`);
    app.router.history.flush();

    await pressTab("files");
    await expect.poll(historyIndex).toBe(3);
    expect([window.location.hash, entry().tag]).toEqual(["", "files"]);
    window.history.back();
    await expect.poll(() => window.location.hash).toBe("#assistant-citation=x");
    expect([entry().tag, shownTab()]).toEqual([undefined, "files"]);
  });

  it("skips a closed tab when Back re-enters the thread, then stops on the shown tab", async () => {
    using _environment = installEnvironment();
    setup();
    await using app = await openOwner(800);
    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);
    await pressTab("diff");
    await expect.poll(historyIndex).toBe(3);
    await app.router.navigate({ href: OTHER_PATH });
    await expect.element(composer(otherThread)).toBeVisible();
    await app.router.navigate({ href: OWNER_PATH });
    await expect.element(composer(ownerThread)).toBeVisible();
    await pressTab("files");
    await expect.poll(historyIndex).toBe(6);
    useRightPanelStore.getState().closeSurface(owner, "diff");
    using steps = vi.spyOn(window.history, "back");

    window.history.back();
    await expect.element(composer(otherThread)).toBeVisible();
    expect(historyIndex()).toBe(4);
    window.history.back();
    await expect.poll(entry).toEqual({ pathname: OWNER_PATH, index: 2, tag: "files" });
    // Two presses and two skips past the closed Diff entries.
    expect([await quietSteps(steps), shownTab(), historyIndex()]).toEqual([4, "files", 2]);
  });

  it.each([
    { name: "another thread", middle: OTHER_PATH },
    { name: "the Pull requests page", middle: "/pull-requests" },
  ])("shows the entry's open tab when Back re-enters the thread from $name", async ({ middle }) => {
    using _environment = installEnvironment();
    setup();
    await using app = await openOwner(800);
    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);
    await app.router.navigate({ href: middle });
    await ownerGone();
    // Reopen Closed View picks a tab of a thread that is not on screen.
    useRightPanelStore.getState().activateSurface(owner, "diff");
    await app.router.navigate({ href: OWNER_PATH });
    await expect.element(composer(ownerThread)).toBeVisible();
    expect(shownTab()).toBe("diff");

    window.history.back();
    await ownerGone();
    window.history.back();
    await expect.poll(shownTab).toBe("files");
    expect(entry()).toEqual({ pathname: OWNER_PATH, index: 2, tag: "files" });
  });

  it("skips a closed tab when Back re-enters the thread from Issues", async () => {
    using _environment = installEnvironment();
    setup();
    await using app = await openOwner(800);
    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);
    await pressTab("diff");
    await expect.poll(historyIndex).toBe(3);
    await app.router.navigate({ href: ISSUES });
    await ownerGone();
    useRightPanelStore.getState().closeSurface(owner, "diff");
    using steps = vi.spyOn(window.history, "back");

    window.history.back();
    await expect.poll(entry).toEqual({ pathname: OWNER_PATH, index: 2, tag: "files" });
    // The press and one skip past the closed Diff entry.
    expect([await quietSteps(steps), shownTab(), historyIndex()]).toEqual([2, "files", 2]);
  });

  it("skips a closed tab when Forward re-enters the thread from Issues", async () => {
    using _environment = installEnvironment();
    setup("files");
    await using _app = await openOwner(800, ISSUES);
    await pressTab("chat");
    await expect.poll(historyIndex).toBe(2);
    await pressTab("diff");
    await expect.poll(historyIndex).toBe(3);
    useRightPanelStore.getState().closeSurface(owner, "files");
    window.history.go(-3);
    await ownerGone();
    using steps = vi.spyOn(window.history, "forward");

    window.history.forward();
    await expect.poll(entry).toEqual({ pathname: OWNER_PATH, index: 2, tag: "chat" });
    // The press and one skip past the closed Files entry.
    expect([await quietSteps(steps), shownTab()]).toEqual([2, "chat"]);
  });

  it("records a tab press and a close while Find stays open", async () => {
    using _environment = installEnvironment();
    setup();
    await using _app = await openOwner(800);
    openThreadFind(scopedThreadKey(owner));
    using _find = { [Symbol.dispose]: closeThreadFind };
    await expect.element(page.getByRole("searchbox", { name: "Find in thread" })).toBeVisible();
    await pressTab("diff");
    await expect.poll(entry).toEqual({ pathname: OWNER_PATH, index: 2, tag: "diff" });
    const close = tabElement("diff").querySelector('button[aria-label^="Close"]')!;
    await userEvent.click(page.elementLocator(close));
    await expect.poll(entry).toEqual({ pathname: OWNER_PATH, index: 2, tag: "files" });
    expect([shownTab(), useThreadFindStore.getState().threadKey]).toEqual([
      "files",
      scopedThreadKey(owner),
    ]);

    window.history.back();
    await expect.poll(shownTab).toBe("chat");
    window.history.forward();
    await expect.poll(shownTab).toBe("files");
    expect(entry()).toEqual({ pathname: OWNER_PATH, index: 2, tag: "files" });
  });

  it("retags the fallback tab when Open in main view closes a side tab and leaves", async () => {
    using _environment = installEnvironment();
    setup();
    await using _app = await openOwner(800);
    await pressTab("files");
    await expect.poll(historyIndex).toBe(2);
    useRightPanelStore.getState().openThread(owner, otherThread.id);
    const side = `thread:${otherThread.id}`;
    await expect.poll(entry).toEqual({ pathname: OWNER_PATH, index: 3, tag: side });
    await userEvent.click(page.elementLocator(tabElement(side)), { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Open in main view" }));
    await expect.element(composer(otherThread)).toBeVisible();
    const fallback = shownTab();
    expect(fallback).not.toBe(side);
    using steps = vi.spyOn(window.history, "back");

    window.history.back();
    await expect.element(composer(ownerThread)).toBeVisible();
    expect([await quietSteps(steps), entry(), shownTab()]).toEqual([
      1,
      { pathname: OWNER_PATH, index: 3, tag: fallback },
      fallback,
    ]);
  });

  it("pushes nothing for wide tab presses, so Back leaves the thread", async () => {
    using _environment = installEnvironment();
    setup();
    await using app = await openOwner(1400);
    const length = window.history.length;

    await pressTab("files");
    await expect.poll(shownTab).toBe("files");
    await pressTab("diff");
    await expect.poll(shownTab).toBe("diff");
    await pressTab("chat");
    await expect.poll(shownTab).toBe("chat");
    expect([entry(), window.history.length]).toEqual([
      { pathname: OWNER_PATH, index: 1, tag: undefined },
      length,
    ]);

    window.history.back();
    await expect.element(composer(otherThread)).toBeVisible();
    expect([app.router.state.location.pathname, historyIndex(), window.history.length]).toEqual([
      OTHER_PATH,
      0,
      length,
    ]);
  });
});
