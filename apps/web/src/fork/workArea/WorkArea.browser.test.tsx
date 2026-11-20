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
import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
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
  type FakeThread,
  installFakeEnvironment,
  isThreadSubscribed,
  runningRun,
  threadWithHistory,
  threadWithQuestion,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadDetails } from "~/state/threads";
import { startPanelLinkDrag } from "./panelLinkDrag";
import { asPaneId, replyTabId, resolveLayout, secondaryChatTabId } from "./workArea.logic";
import { restoredRecord, restoreWorkArea } from "./workAreaStorage.logic";
import { publishWorkAreaView } from "./workAreaView";

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

/** The owner, whose answer links to `target` by a `t3-thread://` link. */
function ownerLinkingTo(target: FakeThread): FakeThread {
  const link = `[the other thread](t3-thread://v2/${ENVIRONMENT_ID}/${target.id})`;
  return {
    ...ownerThread,
    items: ownerThread.items.map((item) =>
      item.type === "assistant_message" ? { ...item, text: `See ${link}.` } : item,
    ),
  };
}

/** The owner, running, with the second of two questions pending: Back, the pill and Stop show. */
function ownerOnSecondQuestion(): FakeThread {
  const asking = threadWithQuestion("owner", "Which file should change?");
  const items = asking.items.map((item) =>
    item.type === "user_input_request"
      ? {
          ...item,
          questions: [
            ...item.questions,
            { ...item.questions[0]!, id: "second", question: "Which test should run?" },
          ],
        }
      : item,
  );
  return { ...asking, items, runs: [runningRun(asking.id, "owner-run-0", 1, "owner-user-0")] };
}
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

async function openOwner(thread: FakeThread = ownerThread) {
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using stack = new AsyncDisposableStack();
  // AppRoot brings its own router.
  const app = stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect
    .element(page.getByRole("textbox", { name: `Message ${thread.title}` }))
    .toBeVisible();
  stack.move();
  return Object.assign(app, { router });
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
  const element = document.querySelector(`[data-right-panel-tab-id="${tab}"]`)!;
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

/** Presses a key on a divider; focus moves on its own while the chat loads. */
const pressOnDivider = (key: string) =>
  document
    .querySelector('[data-work-area-divider="s1"]')!
    .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

const promptOf = () => useComposerDraftStore.getState().getComposerDraft(owner)?.prompt ?? "";

const storedRatio = () => {
  const root = useRightPanelStore.getState().byThreadKey[scopedThreadKey(owner)]?.workArea?.root;
  return root?.kind === "split" ? root.ratio : null;
};

const twoPanes = (ratio = 0.5) =>
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
        ratio,
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

const ownerLayout = () =>
  resolveLayout(useRightPanelStore.getState().byThreadKey[scopedThreadKey(owner)]!);

// A chat link that opens `e.ts` in the owner's work area when dropped on it.
function linkSource(open: () => void, mention?: string): Disposable {
  const link = document.createElement("a");
  link.href = "https://example.com/e";
  link.textContent = "Link e";
  Object.assign(link.style, { position: "fixed", left: "4px", bottom: "4px", zIndex: "80" });
  link.addEventListener("dragstart", (event) => {
    if (mention) event.dataTransfer?.setData(COMPOSER_MENTION_DRAG_TYPE, mention);
    startPanelLinkDrag(event, { panelRef: owner, open });
  });
  document.body.append(link);
  return { [Symbol.dispose]: () => link.remove() };
}

const openE = () => useRightPanelStore.getState().openFile(owner, "e.ts");

async function dragLinkTo(target: Element, at: (box: DOMRect) => Point, force = false) {
  const box = target.getBoundingClientRect();
  const point = at(box);
  await userEvent.dragAndDrop(
    page.getByRole("link", { name: "Link e" }),
    page.elementLocator(target),
    {
      targetPosition: { x: point.x - box.left, y: point.y - box.top },
      steps: 12,
      force,
    },
  );
}

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

  it("drops a tab dragged by one mouse move", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup({ isOpen: false, activeSurfaceId: null, surfaces: [{ id: "files", kind: "files" }] });
    await using _app = await openOwner();
    const element = document.querySelector('[data-right-panel-tab-id="files"]')!;
    pointer(element, "pointerdown", center(element));
    const target = nearRightEdge(panes()[0]!);
    pointer(document, "pointermove", target);
    await vi.waitFor(() => expect(document.querySelector("[data-drag-shield]")).not.toBeNull());
    pointer(document, "pointerup", target);

    await vi.waitFor(() => expect(panes()).toHaveLength(2));
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

    pressOnDivider("ArrowRight");
    expect(storedRatio()).toBeCloseTo(released + 16 / area.width, 5);
  });

  it("redraws a released divider from the store when the store keeps another ratio", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();
    const left = panes()[0]!;
    const area = document.querySelector("[data-work-area]")!.getBoundingClientRect();
    const handle = document.querySelector<HTMLElement>('[data-work-area-divider="s1"]')!;
    using _capture = vi.spyOn(handle, "setPointerCapture").mockImplementation(() => {});
    const start = center(handle);
    const to = { x: start.x - 60, y: start.y };

    pointer(handle, "pointerdown", start);
    pointer(handle, "pointermove", to);
    await vi.waitFor(() => expect(left.getBoundingClientRect().right).toBeCloseTo(to.x, 0));
    // At 720 px the Chat pane needs half the area, so the store clamps the release back to 0.5.
    const shrunk = { narrow: false, size: { width: 720, height: area.height } };
    using _shrunk = { [Symbol.dispose]: publishWorkAreaView(shrunk) };
    pointer(handle, "pointerup", to);

    expect(storedRatio()).toBe(0.5);
    await vi.waitFor(() =>
      expect(left.getBoundingClientRect().right).toBeCloseTo(area.left + area.width / 2, 0),
    );
    await expectColumnOverChatTab();
  });

  it("keeps a squeezed Chat pane wide enough for its whole composer footer and its menus", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();
    pressOnDivider("Home");

    const chatPane = () => panes()[0]!.getBoundingClientRect();
    await vi.waitFor(() => expect(chatPane().width).toBeCloseTo(360, 0));
    await expectColumnOverChatTab();
    const column = primaryColumn();
    const footer = column.querySelector("[data-chat-composer-footer]")!;
    const controls = [...footer.querySelectorAll("button")].filter(
      (button) => button.getBoundingClientRect().width > 0,
    );
    expect(controls.length).toBeGreaterThan(2);
    for (const control of controls) {
      const box = control.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(chatPane().left);
      expect(box.right).toBeLessThanOrEqual(chatPane().right);
    }

    await userEvent.click(column.querySelector<HTMLElement>("[data-chat-provider-model-picker]")!);
    const menu = await vi.waitFor(() => {
      const element = document.querySelector("[data-model-picker-content]");
      expect(element).not.toBeNull();
      return element!.getBoundingClientRect();
    });
    expect(menu.width).toBeGreaterThan(200);
    expect(menu.left).toBeGreaterThanOrEqual(0);
    expect(menu.top).toBeGreaterThanOrEqual(0);
    expect(menu.right).toBeLessThanOrEqual(window.innerWidth);
    expect(menu.bottom).toBeLessThanOrEqual(window.innerHeight);
  });

  it("fits the widest composer footer, a running turn's second question, in a 360 px Chat pane", async () => {
    using _environment = installFakeEnvironment([ownerOnSecondQuestion(), otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();
    await userEvent.click(page.getByRole("button", { name: /Continue/ }).first());
    await expect.element(page.getByRole("button", { name: "Previous question" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
    pressOnDivider("Home");

    const chatPane = () => panes()[0]!.getBoundingClientRect();
    await vi.waitFor(() => expect(chatPane().width).toBeCloseTo(360, 0));
    const footer = primaryColumn().querySelector("[data-chat-composer-footer]")!;
    for (const control of footer.querySelectorAll("button")) {
      const box = control.getBoundingClientRect();
      if (box.width === 0) continue;
      expect(box.left).toBeGreaterThanOrEqual(chatPane().left);
      expect(box.right).toBeLessThanOrEqual(chatPane().right);
    }
  });

  it("puts the Chat's details toggle at the end of its pane's bar, over a header of the bar's height", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();
    const [chatPane, diffPane] = panes();
    const bar = chatPane!.querySelector<HTMLElement>("[data-right-panel-tabbar]")!;
    const toggle = page.getByRole("button", { name: "Toggle thread details panel" });
    await expect.element(toggle).toBeVisible();
    const shownButtons = (root: Element) =>
      [...root.querySelectorAll("button")].filter(
        (button) => button.getBoundingClientRect().width > 0,
      );
    expect(shownButtons(bar).at(-1)).toBe(toggle.element());
    expect(diffPane!.querySelector('[aria-label="Toggle thread details panel"]')).toBeNull();
    expect(document.querySelector('[aria-label="Toggle terminal drawer"]')).toBeNull();
    const header = primaryColumn().querySelector("[data-chat-header]")!.getBoundingClientRect();
    expect(header.height).toBeCloseTo(36, 0);
    expect(header.top).toBeCloseTo(bar.getBoundingClientRect().bottom, 0);

    pressOnDivider("Home");
    await vi.waitFor(() => expect(chatPane!.getBoundingClientRect().width).toBeCloseTo(360, 0));
    await userEvent.click(toggle);
    const details = await vi.waitFor(() => {
      const element = document.querySelector("[data-thread-details-panel]");
      expect(element).not.toBeNull();
      return element!.getBoundingClientRect();
    });
    expect(details.width).toBeGreaterThan(0);
    expect(details.left).toBeGreaterThanOrEqual(0);
    expect(details.top).toBeGreaterThanOrEqual(0);
    expect(details.right).toBeLessThanOrEqual(window.innerWidth);
    expect(details.bottom).toBeLessThanOrEqual(window.innerHeight);
    await userEvent.keyboard("{Escape}");

    await userEvent.click(document.querySelector('[data-right-panel-tab-id="files"]')!);
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Toggle thread details panel"]')).toBeNull(),
    );
  });

  it("splits a lone pane right into a launcher whose letters act only while its pane has focus", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup();
    await using _app = await openOwner();
    const split = page.getByRole("button", { name: "Split right" });
    await expect.element(split).toBeVisible();
    const bar = panes()[0]!.querySelector("[data-right-panel-tabbar]")!;
    const controls = [...bar.querySelectorAll("button")].filter(
      (button) => button.getBoundingClientRect().width > 0,
    );
    expect(controls.slice(-2).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Toggle thread details panel",
      "Split right",
    ]);

    await userEvent.click(split);
    await vi.waitFor(() => expect(panes()).toHaveLength(2));
    await expect.element(page.getByText("Open a surface")).toBeVisible();
    expect(panes()[1]!.textContent).toContain("Open a surface");
    expect(document.querySelector('[aria-label="Split right"]')).toBeNull();
    await expectColumnOverChatTab();

    await userEvent.click(primaryColumn().querySelector("[data-chat-header]")!);
    await userEvent.keyboard("d");
    expect(surfaceKinds(owner)).toEqual([]);
    await userEvent.click(page.getByText("Open a surface"));
    await userEvent.keyboard("d");
    await vi.waitFor(() => expect(surfaceKinds(owner)).toEqual(["diff"]));
    expect(panes()).toHaveLength(2);
    expect(panes()[1]!.querySelector('[data-right-panel-tab-id="launcher"]')).toBeNull();
  });

  it("enables Split right only while the measured area has room for a second pane", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup();
    await using _app = await openOwner();
    const split = page.getByRole("button", { name: "Split right" });
    await expect.element(split).toBeEnabled();

    publishWorkAreaView({ narrow: false, size: { width: 500, height: 800 } });
    await expect.element(split).toBeDisabled();
    const restore = publishWorkAreaView({ narrow: false, size: { width: 1000, height: 800 } });
    using _restore = { [Symbol.dispose]: restore };
    await expect.element(split).toBeEnabled();
  });

  it("closes the launcher's pane with the launcher tab's close button", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup();
    await using _app = await openOwner();
    await userEvent.click(page.getByRole("button", { name: "Split right" }));
    await userEvent.click(page.getByRole("button", { name: "Close New tab" }));
    await vi.waitFor(() => expect(panes()).toHaveLength(1));
    await expect.element(page.getByRole("button", { name: "Split right" })).toBeVisible();
  });

  it("replaces the launcher with a side chat picked in it, after another pane took the focus", async () => {
    // A thread of its own: an earlier test's unanswered command would hold this one's fork.
    const starter = threadWithHistory("side-chat-starter", 1);
    const starterRef = scopeThreadRef(ENVIRONMENT_ID, starter.id);
    using _environment = installFakeEnvironment([starter], { acceptCommands: true });
    setup();
    await using _app = await openOwner(starter);
    await userEvent.click(page.getByRole("button", { name: "Split right" }));
    const pick = await vi.waitFor(() => {
      const button = [...(panes()[1]?.querySelectorAll("button") ?? [])].find((candidate) =>
        candidate.textContent?.includes("Side chat"),
      );
      expect(button).toBeDefined();
      return button!;
    });
    const root =
      useRightPanelStore.getState().byThreadKey[scopedThreadKey(starterRef)]?.workArea?.root;
    if (root?.kind !== "split" || root.first.kind !== "pane")
      throw new Error("not [Chat | New tab]");

    // The side chat exists only after its fork reaches this client; the Chat pane takes focus first.
    pick.click();
    useRightPanelStore
      .getState()
      .updateWorkArea(starterRef, { type: "focus", pane: root.first.id });

    await vi.waitFor(() => expect(surfaceKinds(starterRef)).toEqual(["thread"]));
    await vi.waitFor(() =>
      expect(
        [...panes()[1]!.querySelectorAll("[data-right-panel-tab-id]")].map(
          (tab) => tab.getAttribute("data-right-panel-tab-id")?.split(":")[0],
        ),
      ).toEqual(["thread"]),
    );
    expect(panes()).toHaveLength(2);
  });

  // One thread per row: a thread an earlier row loaded keeps its shell and detail in the registry.
  const settledThread = (name: string): FakeThread => ({
    ...threadWithHistory(name, 1),
    olderSettled: true,
  });
  const settledLink = () => page.getByRole("link", { name: "Thread, the other thread" });

  it("navigates for a linked thread that neither the shell nor a loaded detail places", async () => {
    const settled = settledThread("settled-unplaced");
    const settledRef = scopeThreadRef(ENVIRONMENT_ID, settled.id);
    using _environment = installFakeEnvironment([ownerLinkingTo(settled), settled]);
    setup();
    await using app = await openOwner();

    await userEvent.click(settledLink());

    await vi.waitFor(() =>
      expect(app.router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${settled.id}`),
    );
    expect(
      document.querySelector(`[data-right-panel-tab-id="${secondaryChatTabId(settledRef)}"]`),
    ).toBeNull();
  });

  it("opens a linked thread the shell leaves out but whose detail is loaded as a Chat tab beside the Chat", async () => {
    const settled = settledThread("settled-loaded");
    const settledRef = scopeThreadRef(ENVIRONMENT_ID, settled.id);
    using _environment = installFakeEnvironment([ownerLinkingTo(settled), settled]);
    setup();
    await using app = await openOwner();
    const detail = environmentThreadDetails.quietThreadAtom(settledRef);
    using _loaded = { [Symbol.dispose]: appAtomRegistry.mount(detail) };
    await vi.waitFor(() => expect(appAtomRegistry.get(detail)).not.toBeNull());

    await userEvent.click(settledLink());

    await vi.waitFor(() => expect(panes()).toHaveLength(2));
    expect(
      panes()[1]!.querySelector(`[data-right-panel-tab-id="${secondaryChatTabId(settledRef)}"]`),
    ).not.toBeNull();
    expect(app.router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${ownerThread.id}`);
    await expectColumnOverChatTab();
  });

  it("puts a dropped thread's Chat in a new pane, titles both Chats, and lets only a non-last Chat close", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup();
    await using _app = await openOwner();
    const chatTab = document.querySelector('[data-right-panel-tab-id="chat"]')!;
    expect(chatTab.textContent).toBe("Chat");
    expect(chatTab.querySelector('button[aria-label^="Close"]')).toBeNull();

    const target = nearRightEdge(panes()[0]!);
    moveThreadContextDrag(target, { title: otherThread.title, count: 1 }, [other]);
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

  it("draws a thread drop's edge ghost where the split puts the new pane", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(twoPanes(0.45));
    await using _app = await openOwner();
    const target = nearRightEdge(panes()[1]!);
    moveThreadContextDrag(target, { title: otherThread.title, count: 1 }, [other]);
    const ghost = await vi.waitFor(() => {
      const element = document.querySelector("[data-work-area-drop-ghost='box']");
      expect(element).not.toBeNull();
      return element!.getBoundingClientRect();
    });
    expect(dropThreadContext(target, [other])).toBe(true);
    endThreadContextDrag();

    await vi.waitFor(() => expect(panes()).toHaveLength(3));
    const placed = panes()
      .find((pane) => pane.querySelector(`[data-right-panel-tab-id="${otherChat}"]`) !== null)!
      .getBoundingClientRect();
    for (const edge of ["left", "top", "width", "height"] as const) {
      expect(Math.abs(ghost[edge] - placed[edge]), edge).toBeLessThan(2);
    }
  });

  it("loads another thread's history for a reply tab only once the tab is shown", async () => {
    const reply = replyTabId(other, "other-assistant-0");
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(
      restoredRecord({
        isOpen: false,
        activeSurfaceId: null,
        surfaces: [],
        workArea: restoreWorkArea({
          root: { kind: "pane", id: "p0", tabs: ["chat", reply], active: "chat" },
          tabs: {
            chat: { kind: "primary-chat" },
            [reply]: { kind: "sub-thread", thread: other, first: "other-assistant-0" },
          },
          focused: "p0",
          seq: 1,
        })!,
      }),
    );
    await using _app = await openOwner();
    expect(
      document.querySelector(`[data-right-panel-tab-id="${CSS.escape(reply)}"]`),
    ).not.toBeNull();
    expect(isThreadSubscribed(otherThread.id)).toBe(false);

    await userEvent.click(
      document.querySelector(`[data-right-panel-tab-id="${CSS.escape(reply)}"]`)!,
    );
    await vi.waitFor(() => expect(isThreadSubscribed(otherThread.id)).toBe(true));
  });

  it("takes over a revealed reply tab on a press in its body, though its pane has the focus", async () => {
    const reply = replyTabId(owner, "owner-assistant-0");
    using _environment = installFakeEnvironment([ownerThread]);
    setup(
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
            second: { kind: "pane", id: "p1", tabs: [reply], active: reply },
          },
          tabs: {
            chat: { kind: "primary-chat" },
            [reply]: { kind: "sub-thread", thread: owner, first: "owner-assistant-0" },
          },
          focused: "p1",
          seq: 2,
        })!,
      }),
    );
    await using _app = await openOwner();
    const body = await vi.waitFor(() => {
      const element = document.querySelector('[data-work-area-pane="p1"] [data-reply-tab]');
      expect(element).not.toBeNull();
      return element!;
    });
    const key = scopedThreadKey(owner);
    const workArea = () => useRightPanelStore.getState().byThreadKey[key]?.workArea;
    useRightPanelStore.setState((state) => ({
      byThreadKey: {
        ...state.byThreadKey,
        [key]: {
          ...state.byThreadKey[key]!,
          workArea: { ...workArea()!, focused: asPaneId("p1"), revealed: reply },
        },
      },
    }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-work-area-pane="p1"]')?.className).not.toContain(
        "data-right-panel-tabbar",
      ),
    );

    pointer(body, "pointerdown", center(body));
    pointer(body, "pointerup", center(body));
    await vi.waitFor(() => expect(workArea()?.revealed).toBeUndefined());
    expect(workArea()?.focused).toBe("p1");
  });

  it("sends a shown secondary Chat's panel opens to the owner while mounted, but not agent reveals", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(ownerBesideOther());
    await using _app = await openOwner();
    await vi.waitFor(() => expect(rightPanelHostRef(other)).toEqual(owner));

    const store = useRightPanelStore.getState();
    store.openPullRequest(other, { projectId: "project", repository: "o/r", number: 7 });
    store.reconcileBrowserSurfaces(other, ["agent-tab"]);
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

    moveThreadContextDrag(point, { title: otherThread.title, count: 1 }, [other]);
    await vi.waitFor(() => expect(document.querySelector("[data-drag-shield]")).not.toBeNull());
    moveThreadContextDrag(point, { title: otherThread.title, count: 1 }, [other]);
    expect(document.querySelector("[data-work-area-drop-ghost]")).toBeNull();
    expect(dropThreadContext(point, [other])).toBe(true);
    endThreadContextDrag();

    await vi.waitFor(() => expect(promptOf()).toContain(otherThread.title));
    expect(panes()).toHaveLength(1);
    await vi.waitFor(() => expect(document.querySelector("[data-drag-shield]")).toBeNull());
  });

  it("opens a link dropped near a pane's right edge in a new pane there", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();
    using _link = linkSource(openE);

    await dragLinkTo(panes()[1]!, (box) => ({ x: box.right - 8, y: box.top + box.height / 2 }));

    await vi.waitFor(() => expect(panes()).toHaveLength(3));
    const root = ownerLayout().root;
    expect(root.kind === "split" && root.second.kind === "split" && root.second.axis).toBe("row");
    expect(panes()[2]!.querySelector('[data-right-panel-tab-id="file:e.ts"]')).not.toBeNull();
    expect(document.querySelector("[data-panel-link-drag]")).toBeNull();
    expect(document.querySelector("[data-work-area-drop-ghost]")).toBeNull();
  });

  it("opens a link dropped near the right edge of the desktop preview layer drawn over a pane in a new pane there", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();
    using _link = linkSource(openE);
    // The desktop app draws its preview webview in a fixed layer outside the panes, over one.
    const pane = panes()[1]!.getBoundingClientRect();
    const layer = document.createElement("div");
    layer.dataset.previewViewport = "tab";
    Object.assign(layer.style, {
      position: "fixed",
      left: `${pane.left}px`,
      top: `${pane.top + 40}px`,
      width: `${pane.width}px`,
      height: `${pane.height - 40}px`,
      zIndex: "50",
      pointerEvents: "auto",
    });
    document.body.append(layer);
    using _layer = { [Symbol.dispose]: () => layer.remove() };

    await dragLinkTo(layer, (box) => ({ x: box.right - 8, y: box.top + box.height / 2 }), true);

    // A plain open of e.ts joins pane p1, so a third pane proves the drop's place.
    await vi.waitFor(() => expect(panes()).toHaveLength(3));
    expect(panes()[2]!.querySelector('[data-right-panel-tab-id="file:e.ts"]')).not.toBeNull();
  });

  it("leaves a drag that the composer claims to the composer", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup();
    await using _app = await openOwner();
    const open = vi.fn(openE);
    using _link = linkSource(open, "@e.ts");

    await dragLinkTo(page.getByTestId("composer-editor").element(), (box) => ({
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
    }));

    await vi.waitFor(() => expect(promptOf()).toContain("@e.ts"));
    expect(open).not.toHaveBeenCalled();
    expect(panes()).toHaveLength(1);
  });
});
