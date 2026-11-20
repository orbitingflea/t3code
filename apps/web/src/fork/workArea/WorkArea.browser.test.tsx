import "~/index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
} from "~/components/chat/threadContextDrag";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  rightPanelHostRef,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { secondaryChatTabId } from "./workArea.logic";
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

type Point = { readonly x: number; readonly y: number };

const ownerThread = threadWithHistory("owner", 1);
const otherThread = threadWithHistory("other", 1);
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);
const other = scopeThreadRef(ENVIRONMENT_ID, otherThread.id);

function setup(record?: ThreadRightPanelState) {
  useRightPanelStore.setState({
    byThreadKey: record ? { [scopedThreadKey(owner)]: record } : {},
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
}

async function openOwner() {
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${owner.threadId}`] }),
  );
  await router.load();
  await using stack = new AsyncDisposableStack();
  // AppRoot brings its own router.
  const app = stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect
    .element(page.getByRole("textbox", { name: `Message ${ownerThread.title}` }))
    .toBeVisible();
  stack.move();
  return app;
}

function pointer(target: EventTarget, type: string, at: Point) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: type === "pointermove" ? -1 : 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: at.x,
      clientY: at.y,
    }),
  );
}

const panes = () => [...document.querySelectorAll<HTMLElement>("[data-work-area-pane]")];
const primaryColumn = () => document.querySelector<HTMLElement>("[data-chat-column]")!;
const center = (element: Element): Point => {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
};
const nearRightEdge = (element: Element): Point => {
  const box = element.getBoundingClientRect();
  return { x: box.right - 8, y: box.top + box.height / 2 };
};

async function dragTab(tab: string, to: () => Point) {
  const element = document.querySelector(`[data-tab-id="${tab}"]`)!;
  const start = center(element);
  pointer(element, "pointerdown", start);
  pointer(document, "pointermove", { x: start.x + 10, y: start.y + 10 });
  const target = to();
  pointer(document, "pointermove", target);
  await vi.waitFor(() =>
    expect(document.querySelector("[data-work-area-drop-ghost]")).not.toBeNull(),
  );
  pointer(document, "pointerup", target);
  await vi.waitFor(() => expect(document.querySelector("[data-drag-shield]")).toBeNull());
}

async function expectColumnOverChatTab() {
  await vi.waitFor(() => {
    const column = primaryColumn().getBoundingClientRect();
    const slot = document.querySelector("[data-chat-tab-slot]")!.getBoundingClientRect();
    expect(slot.width).toBeGreaterThan(0);
    for (const edge of ["left", "top", "width", "height"] as const) {
      expect(column[edge]).toBeCloseTo(slot[edge], 0);
    }
  });
}

const promptOf = () => useComposerDraftStore.getState().getComposerDraft(owner)?.prompt ?? "";

const storedRatio = () => {
  const root = useRightPanelStore.getState().byThreadKey[scopedThreadKey(owner)]?.workArea?.root;
  return root?.kind === "split" ? root.ratio : null;
};

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

const otherChat = secondaryChatTabId(other);
const ownerBesideOther = () =>
  restoredRecord({
    isOpen: false,
    activeSurfaceId: null,
    surfaces: [],
    workArea: restoreWorkArea({
      root: {
        kind: "split",
        id: "s1",
        axis: "row",
        ratio: 0.5,
        first: { kind: "pane", id: "p0", tabs: ["chat"], active: "chat" },
        second: { kind: "pane", id: "p1", tabs: [otherChat], active: otherChat },
      },
      tabs: {
        chat: { kind: "primary-chat" },
        [otherChat]: { kind: "secondary-chat", thread: other, placement: 1 },
      },
      focused: "p0",
      seq: 2,
    })!,
  });

const surfaceKinds = (thread: typeof owner) =>
  (useRightPanelStore.getState().byThreadKey[scopedThreadKey(thread)]?.surfaces ?? []).map(
    (surface) => surface.kind,
  );

describe("WorkArea", () => {
  it("splits a pane when a tab drops on its body's edge, and keeps the chat column and its draft", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup({ isOpen: false, activeSurfaceId: null, surfaces: [{ id: "files", kind: "files" }] });
    await using _app = await openOwner();
    const column = primaryColumn();
    await userEvent.click(page.getByTestId("composer-editor"));
    await userEvent.keyboard("half a thought");
    expect(panes()).toHaveLength(1);

    await dragTab("files", () => nearRightEdge(panes()[0]!));

    await vi.waitFor(() => expect(panes()).toHaveLength(2));
    expect(primaryColumn()).toBe(column);
    expect(column.inert).toBe(false);
    await expect.element(page.getByTestId("composer-editor")).toHaveTextContent("half a thought");
    await expectColumnOverChatTab();
  });

  it("moves the chat column with the Chat tab to another pane", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();
    await expectColumnOverChatTab();
    const [left, right] = panes();
    expect(left!.getBoundingClientRect().width).toBeCloseTo(
      right!.getBoundingClientRect().width,
      0,
    );

    await dragTab("chat", () => center(panes()[1]!));

    await vi.waitFor(() => {
      expect(right!.querySelector("[data-chat-tab-slot]")).not.toBeNull();
      expect(left!.querySelector("[data-chat-tab-slot]")).toBeNull();
    });
    await expectColumnOverChatTab();
  });

  it("resizes panes from a divider with no store write until release, and steps it by key", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();
    const left = panes()[0]!;
    const area = document.querySelector("[data-work-area]")!.getBoundingClientRect();
    const handle = document.querySelector<HTMLElement>('[data-work-area-divider="s1"]')!;
    // Synthetic drag events have no active browser pointer to capture.
    using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
    const start = center(handle);
    const to = { x: start.x - 60, y: start.y };

    pointer(handle, "pointerdown", start);
    pointer(handle, "pointermove", to);
    await vi.waitFor(() => expect(left.getBoundingClientRect().right).toBeCloseTo(to.x, 0));
    expect(storedRatio()).toBe(0.5);
    await expectColumnOverChatTab();

    pointer(handle, "pointerup", to);
    await vi.waitFor(() => expect(storedRatio()).toBeCloseTo((to.x - area.left) / area.width, 5));
    const released = storedRatio()!;

    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(storedRatio()).toBeCloseTo(released + 16 / area.width, 5);
  });

  it("puts a dropped thread's Chat in a new pane, titles both Chats, and lets only a non-last Chat close", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup();
    await using _app = await openOwner();
    const chatTab = document.querySelector('[data-tab-id="chat"]')!;
    expect(chatTab.textContent).toBe("Chat");
    expect(chatTab.querySelector('button[aria-label^="Close"]')).toBeNull();

    const target = nearRightEdge(panes()[0]!);
    moveThreadContextDrag(target, { title: otherThread.title, count: 1 });
    await vi.waitFor(() =>
      expect(document.querySelector("[data-work-area-drop-ghost='box']")).not.toBeNull(),
    );
    expect(dropThreadContext(target, [other])).toBe(true);
    endThreadContextDrag();

    await vi.waitFor(() => expect(panes()).toHaveLength(2));
    await expect
      .element(page.getByRole("button", { name: `Close ${otherThread.title}` }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: `Close ${ownerThread.title}` }))
      .toBeVisible();
    await expectColumnOverChatTab();
  });

  it("sends a shown secondary Chat's panel opens to the owner while mounted, but not agent reveals", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(ownerBesideOther());
    await using _app = await openOwner();
    await vi.waitFor(() => expect(rightPanelHostRef(other)).toEqual(owner));

    const store = useRightPanelStore.getState();
    store.openPullRequest(other, { projectId: "project", repository: "o/r", number: 7 });
    store.openBrowser(other, "agent-tab", true);
    expect(surfaceKinds(owner)).toEqual(["pull-request"]);
    expect(surfaceKinds(other)).toEqual(["preview"]);

    store.updateWorkArea(owner, { type: "close", tab: otherChat });
    await vi.waitFor(() => expect(rightPanelHostRef(other)).toEqual(other));
  });

  it("still adds a thread dropped on the composer as context while the work area shields the page", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup();
    await using _app = await openOwner();
    const point = center(page.getByTestId("composer-editor").element());

    moveThreadContextDrag(point, { title: otherThread.title, count: 1 });
    await vi.waitFor(() => expect(document.querySelector("[data-drag-shield]")).not.toBeNull());
    moveThreadContextDrag(point, { title: otherThread.title, count: 1 });
    expect(document.querySelector("[data-work-area-drop-ghost]")).toBeNull();
    expect(dropThreadContext(point, [other])).toBe(true);
    endThreadContextDrag();

    await vi.waitFor(() => expect(promptOf()).toContain(otherThread.title));
    expect(panes()).toHaveLength(1);
    await vi.waitFor(() => expect(document.querySelector("[data-drag-shield]")).toBeNull());
  });
});
