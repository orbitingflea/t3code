import "~/index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type PreviewSessionSnapshot, WS_METHODS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { useBrowserHistoryStore } from "~/browserHistoryStore";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import {
  answerRpc,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { restoredRecord, restoreWorkArea } from "../workArea/workAreaStorage.logic";
import { DashboardLinkScope, DashboardMarkdown } from "./dashboardMarkdown";

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

// The preview browser exists in the desktop app or with a server browser; a test turns it on.
const preview = vi.hoisted(() => ({ available: false }));
vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  isPreviewAvailableFor: () => preview.available,
}));

const ownerThread = threadWithHistory("dashboard-owner", 1);
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);

const twoPanes = () =>
  restoredRecord({
    isOpen: true,
    activeSurfaceId: null,
    surfaces: [
      { id: "files", kind: "files" },
      { id: "diff", kind: "diff" },
    ],
    workArea: restoreWorkArea({
      root: {
        kind: "split",
        id: "s1",
        axis: "row",
        ratio: 0.5,
        first: { kind: "pane", id: "p0", tabs: ["chat", "files"], active: "chat" },
        second: { kind: "pane", id: "p1", tabs: ["diff"], active: "diff" },
      },
      tabs: {
        chat: { kind: "primary-chat" },
        files: { kind: "surface" },
        diff: { kind: "surface" },
      },
      focused: "p0",
      seq: 2,
    })!,
  });

const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: owner.threadId,
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** The owner's work area beside a Dashboard slot that links to a web page. */
async function openOwnerWithSlot() {
  useRightPanelStore.setState({ byThreadKey: { [scopedThreadKey(owner)]: twoPanes() } });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${ownerThread.id}`] }),
  );
  await router.load();
  await using stack = new AsyncDisposableStack();
  stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect
    .element(page.getByRole("textbox", { name: `Message ${ownerThread.title}` }))
    .toBeVisible();
  stack.use(
    await render(
      <AppAtomRegistryProvider>
        <DashboardLinkScope value={{ threadRef: owner, cwd: "/workspace/render" }}>
          <div style={{ position: "fixed", left: 4, bottom: 4, zIndex: 80 }}>
            <DashboardMarkdown
              text={`See [the release notes](https://example.com/notes), [the fix](${COMMIT}), [the board](https:/example.com/board), [the plan](//example.com/plan), [the notes section](#notes), [the canvas](board://canvas) and [the relative notes](http:relative-notes).`}
            />
          </div>
        </DashboardLinkScope>
      </AppAtomRegistryProvider>,
      { router: false },
    ),
  );
  return stack.move();
}

const paneById = (id: string) => document.querySelector(`[data-work-area-pane="${id}"]`)!;
const stripOf = (pane: Element) =>
  [...pane.querySelectorAll("[data-right-panel-tab-id]")].map((tab) =>
    tab.getAttribute("data-right-panel-tab-id"),
  );

const COMMIT = `https://github.com/o/r/commit/${"a".repeat(40)}`;

async function dragLinkBeforeDiff(name = "the release notes") {
  const link = page.getByRole("link", { name });
  await expect.element(link).toBeVisible();
  const diff = paneById("p1").querySelector('[data-right-panel-tab-id="diff"]')!;
  const box = diff.getBoundingClientRect();
  await userEvent.dragAndDrop(link, page.elementLocator(diff), {
    targetPosition: { x: 4, y: box.height / 2 },
    steps: 12,
  });
}

it("opens a Dashboard web link dropped on a pane's tab strip in the preview browser there", async () => {
  preview.available = true;
  using _preview = { [Symbol.dispose]: () => (preview.available = false) };
  using _environment = installFakeEnvironment([ownerThread]);
  const opened: unknown[] = [];
  using _open = answerRpc(WS_METHODS.previewOpen, (input: { readonly url: string }) => {
    opened.push(input.url);
    return Effect.succeed(snapshot("dashboard-web"));
  });
  await using _app = await openOwnerWithSlot();

  await dragLinkBeforeDiff();

  await vi.waitFor(() =>
    expect(stripOf(paneById("p1"))).toEqual(["browser:dashboard-web", "diff"]),
  );
  expect(opened).toEqual(["https://example.com/notes"]);
  // As a chat link's open, the visit joins the project's browser history.
  await vi.waitFor(() =>
    expect(JSON.stringify(useBrowserHistoryStore.getState())).toContain("example.com/notes"),
  );
  expect(stripOf(paneById("p0"))).toEqual(["chat", "files"]);
  expect(document.documentElement.hasAttribute("data-panel-link-drag")).toBe(false);
  expect(document.querySelector("[data-work-area-drop-ghost]")).toBeNull();
});

it("opens a Dashboard commit link dropped on a pane's tab strip in the preview browser, as its click opens any web URL", async () => {
  preview.available = true;
  using _preview = { [Symbol.dispose]: () => (preview.available = false) };
  using _environment = installFakeEnvironment([ownerThread]);
  const opened: unknown[] = [];
  using _open = answerRpc(WS_METHODS.previewOpen, (input: { readonly url: string }) => {
    opened.push(input.url);
    return Effect.succeed(snapshot("dashboard-commit"));
  });
  await using _app = await openOwnerWithSlot();

  await dragLinkBeforeDiff("the fix");

  await vi.waitFor(() =>
    expect(stripOf(paneById("p1"))).toEqual(["browser:dashboard-commit", "diff"]),
  );
  expect(opened).toEqual([COMMIT]);
});

it("opens a dropped Dashboard link at the URL its click resolves to", async () => {
  preview.available = true;
  using _preview = { [Symbol.dispose]: () => (preview.available = false) };
  using _environment = installFakeEnvironment([ownerThread]);
  const opened: unknown[] = [];
  using _open = answerRpc(WS_METHODS.previewOpen, (input: { readonly url: string }) => {
    opened.push(input.url);
    return Effect.succeed(snapshot("dashboard-board"));
  });
  await using _app = await openOwnerWithSlot();

  await dragLinkBeforeDiff("the board");

  await vi.waitFor(() => expect(opened).toEqual(["https://example.com/board"]));
});

it("opens a dropped protocol-relative Dashboard link at the URL its click opens", async () => {
  preview.available = true;
  using _preview = { [Symbol.dispose]: () => (preview.available = false) };
  using _environment = installFakeEnvironment([ownerThread]);
  const opened: unknown[] = [];
  using _open = answerRpc(WS_METHODS.previewOpen, (input: { readonly url: string }) => {
    opened.push(input.url);
    return Effect.succeed(snapshot("dashboard-plan"));
  });
  await using _app = await openOwnerWithSlot();

  await dragLinkBeforeDiff("the plan");

  await vi.waitFor(() => expect(opened).toEqual([`${window.location.protocol}//example.com/plan`]));
});

it.each(["the notes section", "the canvas", "the relative notes"])(
  "does not drag %s, a Dashboard link to no web page, to a pane",
  async (name) => {
    preview.available = true;
    using _preview = { [Symbol.dispose]: () => (preview.available = false) };
    using _environment = installFakeEnvironment([ownerThread]);
    const opened: unknown[] = [];
    using _open = answerRpc(WS_METHODS.previewOpen, (input: { readonly url: string }) => {
      opened.push(input.url);
      return Effect.succeed(snapshot("dashboard-no-page"));
    });
    await using _app = await openOwnerWithSlot();
    let marked = false;
    const observer = new MutationObserver(() => {
      marked ||= document.documentElement.hasAttribute("data-panel-link-drag");
    });
    observer.observe(document.documentElement, { attributes: true });
    using _observer = { [Symbol.dispose]: () => observer.disconnect() };

    await dragLinkBeforeDiff(name);

    expect(marked).toBe(false);
    expect(opened).toEqual([]);
    expect(stripOf(paneById("p1"))).toEqual(["diff"]);
  },
);

it("does not drag a Dashboard web link to a pane while the preview browser is off", async () => {
  using _environment = installFakeEnvironment([ownerThread]);
  const opened: unknown[] = [];
  using _open = answerRpc(WS_METHODS.previewOpen, (input: { readonly url: string }) => {
    opened.push(input.url);
    return Effect.succeed(snapshot("dashboard-web-off"));
  });
  await using _app = await openOwnerWithSlot();
  let marked = false;
  const observer = new MutationObserver(() => {
    marked ||= document.documentElement.hasAttribute("data-panel-link-drag");
  });
  observer.observe(document.documentElement, { attributes: true });
  using _observer = { [Symbol.dispose]: () => observer.disconnect() };

  await dragLinkBeforeDiff();

  expect(marked).toBe(false);
  expect(opened).toEqual([]);
  expect(stripOf(paneById("p1"))).toEqual(["diff"]);
});
