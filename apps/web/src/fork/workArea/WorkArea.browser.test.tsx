import "~/index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { WS_METHODS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { openThreadFind, useThreadFindStore } from "~/components/chat/threadFindStore";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
} from "~/components/chat/threadContextDrag";
import { useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  hostRightPanel,
  rightPanelHostRef,
  selectThreadRightPanelState,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import {
  answerRpc,
  assistantItem,
  emitThreadEvent,
  ENVIRONMENT_ID,
  type FakeThread,
  installFakeEnvironment,
  isThreadSubscribed,
  runningRun,
  threadWithHistory,
  threadWithQuestion,
  type FakeDriver,
  userItem,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
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

interface LayoutEvent {
  readonly name: string;
  readonly args?: {
    readonly beginData?: { readonly frame?: string; readonly partialLayout?: boolean };
  };
}

interface FrameTree {
  readonly frame: { readonly id: string; readonly url: string };
  readonly childFrames?: readonly FrameTree[];
}

/** The layouts this test's frame ran during `work`, from a Chromium trace. */
async function layoutsDuring(work: () => Promise<void>) {
  const session = cdp();
  const events: LayoutEvent[] = [];
  let recording = true;
  let finish = () => {};
  const complete = new Promise<void>((done) => (finish = done));
  session.on("Tracing.dataCollected", (payload) => {
    // The protocol types trace events as string maps; Layout events carry nested `args`.
    if (recording) events.push(...(payload.value as unknown as LayoutEvent[]));
  });
  session.on("Tracing.tracingComplete", () => {
    if (recording) finish();
  });
  const { frameTree } = (await session.send("Page.getFrameTree")) as { frameTree: FrameTree };
  const frames = (tree: FrameTree): FrameTree["frame"][] => [
    tree.frame,
    ...(tree.childFrames ?? []).flatMap(frames),
  ];
  const frame = frames(frameTree).find((each) => each.url === location.href)!.id;
  await session.send("Tracing.start", {
    traceConfig: { includedCategories: ["devtools.timeline"] },
    transferMode: "ReportEvents",
  });
  try {
    await work();
  } finally {
    await session.send("Tracing.end");
    await complete;
    recording = false;
  }
  return events
    .filter((event) => event.name === "Layout" && event.args?.beginData?.frame === frame)
    .map((event) => ({ partialLayout: event.args?.beginData?.partialLayout === true }));
}

/** Emulates a touch screen, so `(any-pointer: coarse)` matches, until disposed. */
async function touchScreen(): Promise<AsyncDisposable> {
  const session = cdp();
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  expect(matchMedia("(any-pointer: coarse)").matches).toBe(true);
  return {
    [Symbol.asyncDispose]: async () => {
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    },
  };
}

function treeRow(path: string): Element | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
}

function touch(target: EventTarget, type: string, at: Point) {
  const point = new Touch({
    identifier: 1,
    target: target instanceof Element ? target : document.body,
    clientX: at.x,
    clientY: at.y,
  });
  target.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      touches: type === "touchend" ? [] : [point],
      targetTouches: type === "touchend" ? [] : [point],
      changedTouches: [point],
    }),
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

  it.each([
    ["", false],
    [" while a reply tab still hosts its thread", true],
  ])("closes Find in a secondary Chat when its tab closes%s", async (_name, replyHost) => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(ownerBesideOther());
    await using _app = await openOwner();
    await vi.waitFor(() => expect(rightPanelHostRef(other)).toEqual(owner));
    using _reply = { [Symbol.dispose]: replyHost ? hostRightPanel(other, owner) : () => {} };
    // The app keeps the first test's server config, which offers no Find, so open it directly.
    await act(() => openThreadFind(scopedThreadKey(other)));
    expect(useThreadFindStore.getState().threadKey).toBe(scopedThreadKey(other));

    await act(() =>
      useRightPanelStore.getState().updateWorkArea(owner, { type: "close", tab: otherChat }),
    );
    await vi.waitFor(() => expect(useThreadFindStore.getState().threadKey).toBeNull());
  });

  it("keeps Find open when a secondary Chat's thread opens on its own page", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(ownerBesideOther());
    await using app = await openOwner();
    await vi.waitFor(() => expect(rightPanelHostRef(other)).toEqual(owner));
    await act(() => openThreadFind(scopedThreadKey(other)));

    await act(() =>
      app.router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId: other.threadId },
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector(`[data-side-chat-pane="${other.threadId}"]`)).toBeNull(),
    );
    await act(() => Promise.resolve());
    expect(useThreadFindStore.getState().threadKey).toBe(scopedThreadKey(other));
  });

  it.each([
    ["closes Find when its tab closes", "close"],
    ["keeps Find open when its thread opens on its own page", "navigate"],
  ] as const)("in a side-chat tab, %s", async (_name, leave) => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup();
    await using app = await openOwner();
    await act(() => useRightPanelStore.getState().openThread(owner, other.threadId));
    await vi.waitFor(() => expect(rightPanelHostRef(other)).toEqual(owner));
    await act(() => openThreadFind(scopedThreadKey(other)));

    if (leave === "close") {
      const surface = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        owner,
      ).surfaces.find((entry) => entry.kind === "thread")!;
      await act(() => useRightPanelStore.getState().closeSurface(owner, surface.id));
    } else {
      await act(() =>
        app.router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: ENVIRONMENT_ID, threadId: other.threadId },
        }),
      );
    }
    await vi.waitFor(() =>
      expect(document.querySelector(`[data-side-chat-pane="${other.threadId}"]`)).toBeNull(),
    );
    await act(() => Promise.resolve());
    expect(useThreadFindStore.getState().threadKey).toBe(
      leave === "close" ? null : scopedThreadKey(other),
    );
  });

  it("starts the timeline minimap at the top of a pane's chat header", async () => {
    const thread = threadWithHistory("owner", 24);
    using _environment = installFakeEnvironment([thread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner(thread);

    const minimap = page.getByTestId("timeline-minimap");
    await expect.element(minimap).toBeVisible();
    const header = primaryColumn().querySelector("[data-chat-header]")!;
    expect(minimap.element().getBoundingClientRect().top).toBeCloseTo(
      header.getBoundingClientRect().top,
      0,
    );
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

  it("starts every layout at a contained box while the primary Chat streams beside another pane", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(ownerBesideOther());
    await using _app = await openOwner();
    await vi.waitFor(() => expect(isThreadSubscribed(otherThread.id)).toBe(true));
    const live = runningRun(ownerThread.id, "owner-live", 2, "owner-live-user");
    await act(async () => {
      await emitThreadEvent(ownerThread.id, { type: "run.created", payload: live });
      await emitThreadEvent(ownerThread.id, {
        type: "turn-item.updated",
        payload: userItem(ownerThread.id, live.id, "owner-live-user", 2, "Continue"),
      });
    });

    // Lay out what setup queued, so the trace holds only the stream's layouts.
    document.body.getBoundingClientRect();
    const layouts = await layoutsDuring(async () => {
      let text = "";
      for (const step of [0, 1, 2, 3, 4]) {
        text += `Step ${step}: the answer grows by one paragraph.\n\n`;
        await act(() =>
          emitThreadEvent(ownerThread.id, {
            type: "turn-item.updated",
            payload: assistantItem(ownerThread.id, live.id, "owner-live-answer", 3, text, true),
          }),
        );
        // Reading the streamed paragraph's box lays it out inside the trace.
        await vi.waitFor(() => {
          const paragraph = [...document.querySelectorAll("p")].find((element) =>
            element.textContent?.startsWith(`Step ${step}:`),
          );
          expect(paragraph?.getBoundingClientRect().height).toBeGreaterThan(0);
        });
      }
    });

    // Each layout starts at a contained box (the Chat column), not at the document.
    expect(layouts.length).toBeGreaterThan(0);
    expect(layouts.filter((layout) => !layout.partialLayout)).toEqual([]);
  });

  it("keeps the Files tree's touch drag preview under the finger in a pane off the window's corner", async () => {
    await using _touch = await touchScreen();
    using _environment = installFakeEnvironment([ownerThread]);
    using _entries = answerRpc(WS_METHODS.projectsListEntries, () =>
      Effect.succeed({ entries: [{ path: "README.md", kind: "file" }], truncated: false }),
    );
    setup(twoPanes());
    await using _app = await openOwner();
    // An earlier test's listing is still waiting on the fake server, which never answers it.
    appAtomRegistry.refresh(
      projectEnvironment.listEntries({
        environmentId: ENVIRONMENT_ID,
        input: { cwd: "/workspace/render", directoryPath: "" },
      }),
    );
    await userEvent.click(document.querySelector('[data-right-panel-tab-id="files"]')!);
    const row = await vi.waitFor(
      () => {
        const found = treeRow("README.md");
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: 5000 },
    );
    const box = row.getBoundingClientRect();
    expect(box.left).toBeGreaterThan(0);
    const start = { x: box.left + 20, y: box.top + box.height / 2 };
    touch(row, "touchstart", start);
    const preview = await vi.waitFor(
      () => {
        const found = (row.getRootNode() as ShadowRoot).querySelector(
          "[data-file-tree-drag-preview]",
        );
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: 3000 },
    );
    const to = { x: start.x + 40, y: start.y + 60 };
    touch(document, "touchmove", to);

    await vi.waitFor(() => {
      const shown = preview.getBoundingClientRect();
      expect(shown.left).toBeCloseTo(to.x - (start.x - box.left), 0);
      expect(shown.top).toBeCloseTo(to.y - (start.y - box.top), 0);
    });
    touch(document, "touchend", to);
  });
});

describe("views of one tab in several panes", () => {
  const paneById = (id: string) =>
    document.querySelector<HTMLElement>(`[data-work-area-pane="${id}"]`)!;
  const stripOf = (pane: Element) =>
    [...pane.querySelectorAll("[data-right-panel-tab-id]")].map((tab) =>
      tab.getAttribute("data-right-panel-tab-id"),
    );
  const tabIn = (pane: string, tab: string) =>
    paneById(pane).querySelector<HTMLElement>(`[data-right-panel-tab-id="${CSS.escape(tab)}"]`)!;
  const strips = () => panes().map(stripOf);

  function press(target: EventTarget, type: string, at: Point, altKey = false) {
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
        altKey,
      }),
    );
  }

  /** A pointer drag of `pane`'s own `tab`, released at `to`; Alt held for a copy. */
  async function dragView(pane: string, tab: string, to: () => Point, altKey = false) {
    const element = tabIn(pane, tab);
    const start = center(element);
    press(element, "pointerdown", start, altKey);
    press(document, "pointermove", { x: start.x + 10, y: start.y + 10 }, altKey);
    const target = to();
    press(document, "pointermove", target, altKey);
    await vi.waitFor(() =>
      expect(document.querySelector("[data-work-area-drop-ghost]")).not.toBeNull(),
    );
    press(document, "pointerup", target, altKey);
    await vi.waitFor(() => expect(document.querySelector("[data-drag-shield]")).toBeNull());
  }

  type Pane = { readonly id: string; readonly tabs: string[]; readonly active: string };
  const saved = (
    surfaces: ThreadRightPanelState["surfaces"],
    first: Pane,
    second: Pane,
    focused = "p0",
  ) =>
    restoredRecord({
      isOpen: true,
      activeSurfaceId: null,
      surfaces,
      workArea: restoreWorkArea({
        root: {
          kind: "split",
          id: "s1",
          axis: "row",
          ratio: 0.5,
          first: { kind: "pane", ...first },
          second: { kind: "pane", ...second },
        },
        tabs: {
          chat: { kind: "primary-chat" },
          ...Object.fromEntries(surfaces.map((surface) => [surface.id, { kind: "surface" }])),
        },
        focused,
        seq: 2,
      })!,
    });
  const FILES_AND_DIFF: ThreadRightPanelState["surfaces"] = [
    { id: "files", kind: "files" },
    { id: "diff", kind: "diff" },
  ];

  it("copies a content tab with an Alt-drag, and moves a dragged second view out of its own pane", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();

    await dragView("p1", "diff", () => center(paneById("p0")), true);
    await vi.waitFor(() => expect(strips()).toEqual([["chat", "files", "diff"], ["diff"]]));

    await dragView("p1", "diff", () => center(paneById("p0")));
    await vi.waitFor(() => expect(strips()).toEqual([["chat", "files", "diff"]]));
    expect(surfaceKinds(owner)).toEqual(["files", "diff"]);
  });

  it("moves the one Files explorer on an Alt-drag", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();

    await dragView("p0", "files", () => center(paneById("p1")), true);

    await vi.waitFor(() => expect(strips()).toEqual([["chat"], ["diff", "files"]]));
  });

  it("focuses the pane of a pressed second view of the focused pane's shown tab", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(
      saved(
        FILES_AND_DIFF,
        { id: "p0", tabs: ["chat", "diff"], active: "diff" },
        { id: "p1", tabs: ["diff", "files"], active: "diff" },
      ),
    );
    await using _app = await openOwner();
    await vi.waitFor(() => expect(tabIn("p1", "diff")).not.toBeNull());
    const at = center(tabIn("p1", "diff"));

    press(tabIn("p1", "diff"), "pointerdown", at);
    press(document, "pointerup", at);

    await vi.waitFor(() => expect(ownerLayout().focused).toBe("p1"));
    expect(strips()).toEqual([
      ["chat", "diff"],
      ["diff", "files"],
    ]);
  });

  it("closes one of two views with its tab's close button and keeps the tab's other view", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(
      saved(
        FILES_AND_DIFF,
        { id: "p0", tabs: ["chat", "files", "diff"], active: "chat" },
        { id: "p1", tabs: ["diff"], active: "diff" },
      ),
    );
    await using _app = await openOwner();

    await userEvent.click(
      page.elementLocator(paneById("p1")).getByRole("button", { name: "Close Diff" }),
    );

    await vi.waitFor(() => expect(strips()).toEqual([["chat", "files", "diff"]]));
    expect(surfaceKinds(owner)).toEqual(["files", "diff"]);
  });

  it("keeps a side chat open when one of its views closes, and closes it with its last view", async () => {
    const side: FakeThread = {
      ...threadWithHistory("multiview-side", 1),
      sideChatOf: ownerThread.id,
    };
    const tab = `thread:${side.id}`;
    using _environment = installFakeEnvironment([ownerThread, side]);
    setup(
      saved(
        [{ id: `thread:${side.id}`, kind: "thread", threadId: side.id }],
        { id: "p0", tabs: ["chat", tab], active: tab },
        { id: "p1", tabs: [tab], active: tab },
      ),
    );
    await using _app = await openOwner();
    const closeIn = (pane: string) =>
      page.elementLocator(paneById(pane)).getByRole("button", { name: "Close side chat" });
    await expect.element(closeIn("p1")).toBeVisible();

    // The side chat's own close path, which releases it, runs only for its last view.
    await userEvent.click(closeIn("p1"));
    await vi.waitFor(() => expect(strips()).toEqual([["chat", tab]]));
    expect(surfaceKinds(owner)).toEqual(["thread"]);

    await userEvent.click(closeIn("p0"));
    await vi.waitFor(() => expect(surfaceKinds(owner)).toEqual([]));
    expect(strips()).toEqual([["chat"]]);
  });

  // The owner's Chat in p0 beside the other thread's Chat in p1 and in p2 below it.
  const otherChatTwice = () =>
    restoredRecord({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
      workArea: restoreWorkArea({
        root: {
          kind: "split",
          id: "s2",
          axis: "row",
          ratio: 0.5,
          first: { kind: "pane", id: "p0", tabs: ["chat"], active: "chat" },
          second: {
            kind: "split",
            id: "s3",
            axis: "column",
            ratio: 0.5,
            first: { kind: "pane", id: "p1", tabs: [otherChat], active: otherChat },
            second: { kind: "pane", id: "p2", tabs: [otherChat], active: otherChat },
          },
        },
        tabs: {
          chat: { kind: "primary-chat" },
          [otherChat]: { kind: "secondary-chat", thread: other, placement: 1 },
        },
        focused: "p0",
        seq: 4,
      })!,
    });

  // V6: a review comment goes to the caret of the composer the user focused last.
  it("inserts context at the caret of the last-focused of two composers of one chat", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(otherChatTwice());
    const draft = useComposerDraftStore.getState();
    draft.setPrompt(other, "alpha beta");
    try {
      await using _app = await openOwner();
      await vi.waitFor(() => expect(panes()).toHaveLength(3));
      const composerIn = (id: string) =>
        page
          .elementLocator(paneById(id))
          .getByRole("textbox", { name: `Message ${otherThread.title}` });
      await expect.element(composerIn("p1")).toBeVisible();
      await expect.element(composerIn("p2")).toBeVisible();
      await composerIn("p2").click();
      await userEvent.keyboard("{End}");
      await composerIn("p1").click();
      await userEvent.keyboard("{Home}");
      await expect.element(composerIn("p1")).toHaveFocus();

      await act(() => {
        draft.addReviewComment(other, {
          id: "multiview",
          sectionId: "file:a/b.ts",
          sectionTitle: "File comment",
          filePath: "a/b.ts",
          startIndex: 3,
          endIndex: 3,
          rangeLabel: "L4",
          text: "Why?",
          diff: "const x = 1;",
        });
      });

      expect(draft.getComposerDraft(other)?.prompt).toMatch(/^\[b\.ts L4\].* alpha beta$/);
    } finally {
      draft.removeReviewComment(other, "multiview");
      draft.setPrompt(other, "");
    }
  });

  it("shows what is typed in one of two composers of one chat in the other, once", async () => {
    using _environment = installFakeEnvironment([ownerThread, otherThread]);
    setup(otherChatTwice());
    const draft = useComposerDraftStore.getState();
    try {
      await using _app = await openOwner();
      await vi.waitFor(() => expect(panes()).toHaveLength(3));
      const composerIn = (id: string) =>
        page
          .elementLocator(paneById(id))
          .getByRole("textbox", { name: `Message ${otherThread.title}` });
      await expect.element(composerIn("p1")).toBeVisible();
      await expect.element(composerIn("p2")).toBeVisible();
      // The editor keeps a zero-width caret holder in an empty paragraph.
      const texts = () =>
        ["p1", "p2"].map((id) =>
          (composerIn(id).element().textContent ?? "").replace(/[\u200b\ufeff]/g, "").trim(),
        );

      await composerIn("p1").click();
      await userEvent.keyboard("first words");
      await vi.waitFor(() => expect(texts()).toEqual(["first words", "first words"]));

      await composerIn("p2").click();
      await userEvent.keyboard("{End} and more");
      await vi.waitFor(() =>
        expect(texts()).toEqual(["first words and more", "first words and more"]),
      );
      expect(draft.getComposerDraft(other)?.prompt).toBe("first words and more");
    } finally {
      draft.setPrompt(other, "");
    }
  });
});
