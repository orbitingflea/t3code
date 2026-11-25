import "~/index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type DeviceServiceState, ProjectId, WS_METHODS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { BrowserDocumentFrame } from "~/components/files/BrowserDocumentFrame";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  rightPanelHostRef,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import {
  answerRpc,
  dispatchedCommands,
  ENVIRONMENT_ID,
  type FakeDriver,
  rejectPendingCommand,
  threadWithHistory,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { deviceEnvironment } from "~/state/device";

import { type DragThread, holdSideChatForks, installDragEnvironment } from "./dragTestEnvironment";
import { asTabId, LAUNCHER, holders, resolveLayout, secondaryChatTabId } from "./workArea.logic";
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

// Dictation that a test turns on: its Escape cancels it, as the app's dictation shortcut does.
const voice = vi.hoisted(() => ({ recording: false, cancel: vi.fn() }));
vi.mock(import("~/speech/useEnvironmentSpeechInput"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironmentSpeechInput: (input) => {
      const speech = actual.useEnvironmentSpeechInput(input);
      if (!voice.recording) return speech;
      return {
        ...speech,
        available: true,
        state: { phase: "recording", error: null, errorAction: null } as const,
        blocksSubmission: true,
        freezesEditor: true,
        cancel: voice.cancel,
      };
    },
  };
});

type Point = { readonly x: number; readonly y: number };

const ownerThread = threadWithHistory("owner", 1);
const otherThread = threadWithHistory("other", 1);
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);
const other = scopeThreadRef(ENVIRONMENT_ID, otherThread.id);

/** The owner, whose answer links to `target` by a `t3-thread://` link. */
function ownerLinkingTo(target: DragThread): DragThread {
  const link = `[the other thread](t3-thread://v2/${ENVIRONMENT_ID}/${target.id})`;
  return {
    ...ownerThread,
    items: ownerThread.items.map((item) =>
      item.type === "assistant_message" ? { ...item, text: `See ${link}.` } : item,
    ),
  };
}

function setup(record?: ThreadRightPanelState, thread = owner) {
  useRightPanelStore.setState({
    byThreadKey: record ? { [scopedThreadKey(thread)]: record } : {},
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
}

async function openOwner(thread: DragThread = ownerThread) {
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

const panes = () => [...document.querySelectorAll<HTMLElement>("[data-work-area-pane]")];

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

/** A real native drag of `source` released at `at` in `target`, by default before its first tab. */
async function dragOnto(
  source: Element,
  target: Element,
  at: (box: DOMRect) => Point = (box) => ({ x: box.left + 4, y: box.top + box.height / 2 }),
  force = false,
) {
  const box = target.getBoundingClientRect();
  const point = at(box);
  await userEvent.dragAndDrop(page.elementLocator(source), page.elementLocator(target), {
    targetPosition: { x: point.x - box.left, y: point.y - box.top },
    steps: 12,
    force,
  });
}

/** The tab ids of a pane's strip, in the order drawn. */
const stripOf = (pane: Element) =>
  [...pane.querySelectorAll("[data-right-panel-tab-id]")].map((tab) =>
    tab.getAttribute("data-right-panel-tab-id"),
  );
const paneById = (id: string) => document.querySelector(`[data-work-area-pane="${id}"]`)!;
const tabIn = (pane: string, tab: string) =>
  paneById(pane).querySelector(`[data-right-panel-tab-id="${CSS.escape(tab)}"]`)!;

/** Whether `check` held at any DOM change until the returned function is called. */
function watchFor(check: () => boolean): () => boolean {
  let seen = check();
  const observer = new MutationObserver(() => {
    seen ||= check();
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true });
  return () => {
    observer.disconnect();
    return seen;
  };
}
const dragShown = () =>
  document.documentElement.hasAttribute("data-panel-link-drag") ||
  document.querySelector("[data-work-area-drop-ghost]") !== null;

async function expectDragDone() {
  await vi.waitFor(() => {
    expect(document.documentElement.hasAttribute("data-panel-link-drag")).toBe(false);
    expect(document.querySelector("[data-work-area-drop-ghost]")).toBeNull();
  });
}

const ELSEWHERE = ProjectId.make("project-elsewhere");
const elsewhereThread: DragThread = { ...threadWithHistory("elsewhere", 1), projectId: ELSEWHERE };
const elsewhere = scopeThreadRef(ENVIRONMENT_ID, elsewhereThread.id);
const withElsewhere = { projects: [{ id: ELSEWHERE, title: "elsewhere" }] };

const sidebarRow = (thread: typeof owner) =>
  vi.waitFor(() => {
    const element = document.querySelector(`li[data-thread-item="${scopedThreadKey(thread)}"]`);
    expect(element).not.toBeNull();
    return element!;
  });
/** A chip in the timeline; an earlier test's composer draft can hold one of the same name. */
async function threadChip(title: string) {
  const chip = page
    .getByLabelText("Conversation", { exact: false })
    .getByRole("link", { name: `Thread, ${title}` });
  await expect.element(chip).toBeVisible();
  return chip.element();
}

describe("drag to a pane", () => {
  it("opens a sidebar chat dropped on a pane's tab strip as a Chat tab there, before the tab under it", async () => {
    using _environment = installDragEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();

    await dragOnto(await sidebarRow(other), tabIn("p1", "diff"));

    await vi.waitFor(() => expect(stripOf(paneById("p1"))).toEqual([otherChat, "diff"]));
    expect(stripOf(paneById("p0"))).toEqual(["chat", "files"]);
  });

  it("leaves another project's sidebar chat dropped on a pane out of the work area", async () => {
    using _environment = installDragEnvironment([ownerThread, elsewhereThread], withElsewhere);
    setup(twoPanes());
    await using app = await openOwner();
    const row = await sidebarRow(elsewhere);
    const shown = watchFor(() => document.querySelector("[data-work-area-drop-ghost]") !== null);

    await dragOnto(row, tabIn("p1", "diff"));

    expect(shown()).toBe(false);
    expect(stripOf(paneById("p1"))).toEqual(["diff"]);
    expect(stripOf(paneById("p0"))).toEqual(["chat", "files"]);
    expect(surfaceKinds(owner)).toEqual(["files", "diff"]);
    expect(app.router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${ownerThread.id}`);
  });

  it("opens a same-project thread chip dropped near a pane's right edge as a Chat in a new pane", async () => {
    using _environment = installDragEnvironment([ownerLinkingTo(otherThread), otherThread]);
    // Wide enough for a second Chat beside Diff.
    setup(twoPanes(0.45));
    await using app = await openOwner();

    await dragOnto(await threadChip(otherThread.title), panes()[1]!, (box) => ({
      x: box.right - 8,
      y: box.top + box.height / 2,
    }));

    await vi.waitFor(() => expect(panes()).toHaveLength(3));
    expect(stripOf(panes()[2]!)).toEqual([otherChat]);
    expect(stripOf(paneById("p1"))).toEqual(["diff"]);
    expect(app.router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${ownerThread.id}`);
    await expectDragDone();
  });

  it("opens a chip of the owner's side chat dropped on a pane's tab strip as its tab there", async () => {
    const side: DragThread = { ...threadWithHistory("owner-side", 1), sideChatOf: ownerThread.id };
    using _environment = installDragEnvironment([ownerLinkingTo(side), side]);
    setup(twoPanes());
    await using app = await openOwner();

    await dragOnto(await threadChip(side.title), tabIn("p1", "diff"));

    await vi.waitFor(() => expect(stripOf(paneById("p1"))).toEqual([`thread:${side.id}`, "diff"]));
    expect(app.router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${ownerThread.id}`);
    await expectDragDone();
  });

  it("does not drag another project's thread chip to a pane, and its click still navigates", async () => {
    using _environment = installDragEnvironment(
      [ownerLinkingTo(elsewhereThread), elsewhereThread],
      withElsewhere,
    );
    setup(twoPanes());
    await using app = await openOwner();
    const chip = await threadChip(elsewhereThread.title);
    const shown = watchFor(dragShown);

    await dragOnto(chip, tabIn("p1", "diff"));

    expect(shown()).toBe(false);
    expect(stripOf(paneById("p1"))).toEqual(["diff"]);
    expect(surfaceKinds(owner)).toEqual(["files", "diff"]);
    expect(app.router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${ownerThread.id}`);

    await userEvent.click(chip);
    await vi.waitFor(() =>
      expect(app.router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${elsewhereThread.id}`),
    );
  });

  it("does not drag a chip of a hosted Chat's side chat to a pane, since its click leaves the page", async () => {
    const otherSide: DragThread = {
      ...threadWithHistory("other-side", 1),
      sideChatOf: otherThread.id,
    };
    using _environment = installDragEnvironment([
      ownerLinkingTo(otherSide),
      otherThread,
      otherSide,
    ]);
    setup(ownerBesideOther());
    await using app = await openOwner();
    await vi.waitFor(() =>
      expect(scopedThreadKey(rightPanelHostRef(other))).toBe(scopedThreadKey(owner)),
    );
    const chip = await threadChip(otherSide.title);
    const shown = watchFor(dragShown);

    await dragOnto(chip, tabIn("p1", otherChat));

    expect(shown()).toBe(false);
    expect(stripOf(paneById("p1"))).toEqual([otherChat]);
    expect(surfaceKinds(owner)).toEqual([]);

    await userEvent.click(chip);
    await vi.waitFor(() =>
      expect(app.router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${otherThread.id}`),
    );
  });
});

async function openPlusMenu(pane: string) {
  await userEvent.click(
    page.elementLocator(paneById(pane).querySelector('[aria-label="Add panel surface"]')!),
  );
  await expect.element(page.getByRole("menu")).toBeVisible();
}
const menuItem = (name: string) => page.getByRole("menuitem", { name: new RegExp(`^${name}`) });
const menuOpen = () => document.querySelector('[data-slot="menu-popup"][data-open]') !== null;
/** A drag from the open menu; its backdrop covers the panes, as for the user's pointer. */
const dragMenuItemOnto = (name: string, target: Element, at?: (box: DOMRect) => Point) =>
  dragOnto(menuItem(name).element(), target, at, true);
const atRightEdge = (box: DOMRect) => ({ x: box.right - 8, y: box.top + box.height / 2 });

describe("drag a + menu or launcher item to a pane", () => {
  it("opens a + item dropped near another pane's right edge in a new pane, leaving no arm and closing the menu", async () => {
    using _environment = installDragEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();
    await openPlusMenu("p0");

    await dragMenuItemOnto("Terminal", panes()[1]!, atRightEdge);

    await vi.waitFor(() => expect(panes()).toHaveLength(3));
    expect(stripOf(panes()[2]!)).toEqual([expect.stringMatching(/^terminal:/)]);
    expect(stripOf(paneById("p0"))).toEqual(["chat", "files"]);
    expect(ownerLayout().armed).toBeUndefined();
    await vi.waitFor(() => expect(menuOpen()).toBe(false));
    await expectDragDone();
  });

  it("opens a launcher item dropped on another pane's tab strip in that pane, keeping the launcher", async () => {
    using _environment = installDragEnvironment([ownerThread, otherThread]);
    setup();
    await using _app = await openOwner();
    await userEvent.click(page.getByRole("button", { name: "Split right" }));
    const files = await vi.waitFor(() => {
      const button = [...(panes()[1]?.querySelectorAll("button") ?? [])].find((candidate) =>
        candidate.textContent?.startsWith("Files"),
      );
      expect(button).toBeDefined();
      return button!;
    });

    await dragOnto(files, panes()[0]!.querySelector('[data-right-panel-tab-id="chat"]')!);

    await vi.waitFor(() => expect(stripOf(panes()[0]!)).toEqual(["files", "chat"]));
    expect(stripOf(panes()[1]!)).toEqual([LAUNCHER]);
    expect(ownerLayout().armed).toBeUndefined();
  });

  it("moves nothing when a + item is released over the open menu", async () => {
    using _environment = installDragEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();
    await openPlusMenu("p0");

    await dragMenuItemOnto("Diff", menuItem("Terminal").element(), (box) => ({
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
    }));

    await vi.waitFor(() => expect(menuOpen()).toBe(false));
    expect(panes()).toHaveLength(2);
    expect(stripOf(paneById("p1"))).toEqual(["diff"]);
    expect(stripOf(paneById("p0"))).toEqual(["chat", "files"]);
    expect(surfaceKinds(owner)).toEqual(["files", "diff"]);
    expect(ownerLayout().armed).toBeUndefined();
  });

  it.each<[string, () => Promise<unknown>, readonly (readonly string[])[]]>([
    ["clicked", () => userEvent.click(menuItem("Diff")), [["chat", "files"], ["diff"]]],
    [
      "dropped near its pane's right edge, as a second view there",
      () => dragMenuItemOnto("Diff", paneById("p1"), atRightEdge),
      [["chat", "files"], ["diff"], ["diff"]],
    ],
  ])(
    "leaves no arm when Diff, alone in the pane whose + menu offers it, is %s",
    async (_, pick, strips) => {
      using _environment = installDragEnvironment([ownerThread, otherThread]);
      setup(twoPanes());
      await using _app = await openOwner();
      await openPlusMenu("p1");

      await pick();

      await vi.waitFor(() => expect(menuOpen()).toBe(false));
      await vi.waitFor(() => expect(panes().map(stripOf)).toEqual(strips));
      expect(ownerLayout().armed).toBeUndefined();
      await expectDragDone();
    },
  );

  it("places a dropped Side chat by the user's newer click when the drop's open settles after it", async () => {
    const starter = threadWithHistory("side-chat-late-drop", 1);
    const starterRef = scopeThreadRef(ENVIRONMENT_ID, starter.id);
    using _environment = installDragEnvironment([starter]);
    using forks = holdSideChatForks();
    setup(twoPanes(), starterRef);
    await using _app = await openOwner(starter);
    await openPlusMenu("p0");

    await dragMenuItemOnto("Side chat", tabIn("p1", "diff"));
    await vi.waitFor(() => expect(forks.pending()).toBe(true));
    await userEvent.click(tabIn("p0", "files"));
    await forks.accept();

    const sideTab = await vi.waitFor(() => {
      const tab = stripOf(paneById("p0")).find((id) => id?.startsWith("thread:"));
      expect(tab).toBeDefined();
      return tab!;
    });
    expect(stripOf(paneById("p0"))).toEqual(["chat", "files", sideTab]);
    expect(stripOf(paneById("p1"))).toEqual(["diff"]);
  });

  it.each<[string, string, () => Promise<unknown>]>([
    ["clicked", "side-chat-rejected-click", () => userEvent.click(menuItem("Side chat"))],
    [
      "dropped on another pane's tab strip",
      "side-chat-rejected-drop",
      () => dragMenuItemOnto("Side chat", tabIn("p1", "diff")),
    ],
  ])("leaves no arm when the server rejects a Side chat %s", async (_, name, pick) => {
    const starter = threadWithHistory(name, 1);
    const starterRef = scopeThreadRef(ENVIRONMENT_ID, starter.id);
    using _environment = installDragEnvironment([starter], {
      acceptCommands: true,
      holdCommand: (command) => command.type === "thread.fork",
    });
    setup(twoPanes(), starterRef);
    await using _app = await openOwner(starter);
    await openPlusMenu("p0");

    await pick();
    await vi.waitFor(() =>
      expect(dispatchedCommands().some((command) => command.type === "thread.fork")).toBe(true),
    );
    await rejectPendingCommand("Side chats are paused.");

    await expect.element(page.getByText("Side chats are paused.")).toBeVisible();
    await vi.waitFor(() => expect(menuOpen()).toBe(false));
    expect(
      resolveLayout(useRightPanelStore.getState().byThreadKey[scopedThreadKey(starterRef)]!).armed,
    ).toBeUndefined();
    expect(stripOf(paneById("p0"))).toEqual(["chat", "files"]);
    expect(stripOf(paneById("p1"))).toEqual(["diff"]);
    await expectDragDone();
  });

  // Device before its setup.
  const devices: DeviceServiceState = {
    hosts: [],
    hostStatus: "ready",
    hostStatuses: {},
    devices: [],
    sessions: [],
    onboardingCompleted: false,
    agentAccessEnabled: false,
    hubBasePath: "/api/device-hub",
    revision: 1,
  };
  const deviceState = () =>
    AsyncResult.getOrElse(
      appAtomRegistry.get(deviceEnvironment.state({ environmentId: ENVIRONMENT_ID, input: {} })),
      () => null,
    );

  it("does not drag Device while its click opens device setup instead of a tab", async () => {
    using _environment = installDragEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();
    await openPlusMenu("p0");
    const shown = watchFor(dragShown);

    await dragMenuItemOnto("Device", tabIn("p1", "diff"));

    expect(shown()).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(ownerLayout().armed).toBeUndefined();
    expect(stripOf(paneById("p1"))).toEqual(["diff"]);
  });

  it("opens the Device tab that device setup started from a + menu in that menu's pane", async () => {
    const configured = Deferred.makeUnsafe<DeviceServiceState>();
    using _environment = installDragEnvironment([ownerThread, otherThread]);
    // The server pushes the completed setup to the state subscription, as it does after configure.
    using _state = answerRpc(WS_METHODS.subscribeDeviceState, () =>
      Stream.make(devices).pipe(
        Stream.concat(Stream.fromEffect(Deferred.await(configured))),
        Stream.concat(Stream.never),
      ),
    );
    using _list = answerRpc(WS_METHODS.deviceList, () => Effect.succeed(devices));
    using _configure = answerRpc(WS_METHODS.deviceConfigure, () => {
      const done = { ...devices, onboardingCompleted: true };
      return Deferred.succeed(configured, done).pipe(Effect.as(done));
    });
    // An earlier test's mount may hold the unanswered subscription.
    appAtomRegistry.refresh(deviceEnvironment.state({ environmentId: ENVIRONMENT_ID, input: {} }));
    setup(twoPanes());
    await using _app = await openOwner();
    await openPlusMenu("p0");

    await userEvent.click(menuItem("Device"));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    await userEvent.click(page.getByRole("button", { name: "Done" }));

    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await vi.waitFor(() =>
      expect(stripOf(paneById("p0"))).toEqual(["chat", "files", expect.stringMatching(/^device/)]),
    );
    expect(stripOf(paneById("p1"))).toEqual(["diff"]);
    expect(ownerLayout().armed).toBeUndefined();
  });

  it("opens nothing when Device, set up as its drag starts, is turned off before the drop", async () => {
    const ready: DeviceServiceState = { ...devices, onboardingCompleted: true };
    const off: DeviceServiceState = { ...ready, hostStatus: "disabled" };
    const turnedOff = Deferred.makeUnsafe<DeviceServiceState>();
    using _environment = installDragEnvironment([ownerThread, otherThread]);
    using _state = answerRpc(WS_METHODS.subscribeDeviceState, () =>
      Stream.make(ready).pipe(
        Stream.concat(Stream.fromEffect(Deferred.await(turnedOff))),
        Stream.concat(Stream.never),
      ),
    );
    using _list = answerRpc(WS_METHODS.deviceList, () => Effect.succeed(ready));
    appAtomRegistry.refresh(deviceEnvironment.state({ environmentId: ENVIRONMENT_ID, input: {} }));
    setup(twoPanes());
    await using _app = await openOwner();
    await openPlusMenu("p0");
    await vi.waitFor(() => expect(deviceState()?.onboardingCompleted).toBe(true));
    // Device turns off once the drag has started, and the drop records what it sees.
    let atDrop: string | undefined;
    const turnOff = () => Deferred.doneUnsafe(turnedOff, Effect.succeed(off));
    const recordAtDrop = () => (atDrop = deviceState()?.hostStatus);
    document.addEventListener("dragover", turnOff, { once: true, capture: true });
    document.addEventListener("drop", recordAtDrop, { once: true, capture: true });
    using _listeners = {
      [Symbol.dispose]: () => {
        document.removeEventListener("dragover", turnOff, { capture: true });
        document.removeEventListener("drop", recordAtDrop, { capture: true });
      },
    };
    const shown = watchFor(dragShown);

    await dragMenuItemOnto("Device", tabIn("p1", "diff"));

    expect(shown()).toBe(true);
    expect(atDrop).toBe("disabled");
    await expectDragDone();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(stripOf(paneById("p1"))).toEqual(["diff"]);
    expect(surfaceKinds(owner)).toEqual(["files", "diff"]);
    expect(ownerLayout().armed).toBeUndefined();
  });

  it("places the primary Chat where its + item is dropped", async () => {
    using _environment = installDragEnvironment([ownerThread, otherThread]);
    setup(
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
            first: { kind: "pane", id: "p0", tabs: ["files"], active: "files" },
            second: { kind: "pane", id: "p1", tabs: [otherChat, "diff"], active: otherChat },
          },
          tabs: {
            files: { kind: "surface" },
            diff: { kind: "surface" },
            [otherChat]: { kind: "secondary-chat", thread: other, placement: 1 },
          },
          focused: "p0",
          seq: 2,
        })!,
      }),
    );
    await page.viewport(1400, 900);
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${ownerThread.id}`] }),
    );
    await router.load();
    await using _app = await render(<AppRoot router={router} />, { router: false });
    await vi.waitFor(() => expect(tabIn("p1", otherChat)).not.toBeNull());
    await openPlusMenu("p0");

    await dragMenuItemOnto("Chat", tabIn("p1", "diff"));

    await vi.waitFor(() => expect(stripOf(paneById("p1"))).toEqual([otherChat, "chat", "diff"]));
    expect(stripOf(paneById("p0"))).toEqual(["files"]);
    expect(ownerLayout().armed).toBeUndefined();
    // The drop removes the Chat item from the menu, so the item never sees its own dragend.
    await vi.waitFor(() => expect(menuOpen()).toBe(false));
    await expectDragDone();
  });

  it("opens a view of a + item's already-placed tab in the strip it is dropped on", async () => {
    using _environment = installDragEnvironment([ownerThread, otherThread]);
    setup(twoPanes());
    await using _app = await openOwner();
    await openPlusMenu("p1");
    await dragMenuItemOnto("Diff", tabIn("p0", "files"));

    await vi.waitFor(() => expect(stripOf(paneById("p0"))).toEqual(["chat", "diff", "files"]));
    expect(stripOf(paneById("p1"))).toEqual(["diff"]);
    expect(surfaceKinds(owner)).toEqual(["files", "diff"]);
    await expectDragDone();
  });

  it("shows a + item's tab hidden behind another in the pane it is dropped in, in its slot, as its click does", async () => {
    using _environment = installDragEnvironment([ownerThread, otherThread]);
    setup(
      restoredRecord({
        isOpen: true,
        activeSurfaceId: null,
        surfaces: [
          { id: "diff", kind: "diff" },
          { id: "files", kind: "files" },
        ],
        workArea: restoreWorkArea({
          root: {
            kind: "split",
            id: "s1",
            axis: "row",
            ratio: 0.5,
            first: { kind: "pane", id: "p0", tabs: ["chat"], active: "chat" },
            second: { kind: "pane", id: "p1", tabs: ["diff", "files"], active: "files" },
          },
          tabs: {
            chat: { kind: "primary-chat" },
            files: { kind: "surface" },
            diff: { kind: "surface" },
          },
          focused: "p0",
          seq: 2,
        })!,
      }),
    );
    await using _app = await openOwner();
    await openPlusMenu("p1");
    const shown = watchFor(() => document.querySelector("[data-work-area-drop-ghost]") !== null);

    await dragMenuItemOnto("Diff", paneById("p1"), (box) => ({
      x: box.left + box.width / 2,
      y: box.top + box.height * 0.6,
    }));

    expect(shown()).toBe(true);
    await vi.waitFor(() =>
      expect(holders(ownerLayout().root, asTabId("diff"))[0]?.active).toBe("diff"),
    );
    expect(stripOf(paneById("p1"))).toEqual(["diff", "files"]);
    expect(panes()).toHaveLength(2);
    await vi.waitFor(() => expect(menuOpen()).toBe(false));
    await expectDragDone();
  });

  // [Chat Files | Diff over the launcher]: a click on Files is in neither the drag's source nor
  // its target.
  const threePanes = (focused = "p0") =>
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
          second: {
            kind: "split",
            id: "s2",
            axis: "column",
            ratio: 0.5,
            first: { kind: "pane", id: "p1", tabs: ["diff"], active: "diff" },
            second: { kind: "pane", id: "p2", tabs: [LAUNCHER], active: LAUNCHER },
          },
        },
        tabs: {
          chat: { kind: "primary-chat" },
          files: { kind: "surface" },
          diff: { kind: "surface" },
          [LAUNCHER]: { kind: "launcher" },
        },
        focused,
        seq: 3,
      })!,
    });

  it.each<[string, string, () => Promise<unknown>]>([
    [
      "the + menu of one pane onto another",
      "side-chat-overtaken-menu",
      async () => {
        await openPlusMenu("p1");
        await dragMenuItemOnto("Side chat", tabIn("p2", LAUNCHER));
      },
    ],
    [
      "a launcher onto another pane",
      "side-chat-overtaken-launcher",
      async () => {
        const pick = [...paneById("p2").querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Side chat"),
        )!;
        await dragOnto(pick, tabIn("p1", "diff"));
      },
    ],
  ])(
    "places a Side chat dragged from %s by a newer click in a third pane when the open settles after it",
    async (_, name, drop) => {
      const starter = threadWithHistory(name, 1);
      const starterRef = scopeThreadRef(ENVIRONMENT_ID, starter.id);
      using _environment = installDragEnvironment([starter]);
      using forks = holdSideChatForks();
      setup(threePanes(), starterRef);
      await using _app = await openOwner(starter);

      await drop();
      await vi.waitFor(() => expect(forks.pending()).toBe(true));
      await userEvent.click(tabIn("p0", "files"));
      await forks.accept();

      const sideTab = await vi.waitFor(() => {
        const tab = stripOf(paneById("p0")).find((id) => id?.startsWith("thread:"));
        expect(tab).toBeDefined();
        return tab!;
      });
      expect(stripOf(paneById("p0"))).toEqual(["chat", "files", sideTab]);
      expect(stripOf(paneById("p1"))).toEqual(["diff"]);
      expect(stripOf(paneById("p2"))).toEqual([LAUNCHER]);
      const layout = resolveLayout(
        useRightPanelStore.getState().byThreadKey[scopedThreadKey(starterRef)]!,
      );
      expect(layout.focused).toBe("p0");
      expect(layout.armed).toBeUndefined();
    },
  );
  it("places a Side chat dropped from a launcher by a newer launcher shortcut when the open settles after it", async () => {
    const starter = threadWithHistory("side-chat-overtaken-shortcut", 1);
    const starterRef = scopeThreadRef(ENVIRONMENT_ID, starter.id);
    using _environment = installDragEnvironment([starter]);
    using forks = holdSideChatForks();
    setup(threePanes("p2"), starterRef);
    await using _app = await openOwner(starter);
    const pick = [...paneById("p2").querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Side chat"),
    )!;

    await dragOnto(pick, tabIn("p0", "files"));
    await vi.waitFor(() => expect(forks.pending()).toBe(true));
    // The launcher's shortcut, which the launcher stops at the window, opens Terminal in its pane.
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("t");
    await vi.waitFor(() =>
      expect(stripOf(paneById("p2"))).toEqual([expect.stringMatching(/^terminal:/)]),
    );
    await forks.accept();

    const sideTab = await vi.waitFor(() => {
      const tab = stripOf(paneById("p2")).find((id) => id?.startsWith("thread:"));
      expect(tab).toBeDefined();
      return tab!;
    });
    expect(stripOf(paneById("p2"))).toEqual([expect.stringMatching(/^terminal:/), sideTab]);
    expect(stripOf(paneById("p0"))).toEqual(["chat", "files"]);
    expect(stripOf(paneById("p1"))).toEqual(["diff"]);
  });
  it("places a dropped Side chat by a newer Escape that cancels dictation when the open settles after it", async () => {
    voice.recording = true;
    voice.cancel.mockClear();
    using _voice = { [Symbol.dispose]: () => (voice.recording = false) };
    const starter = threadWithHistory("side-chat-overtaken-dictation", 1);
    const starterRef = scopeThreadRef(ENVIRONMENT_ID, starter.id);
    using _environment = installDragEnvironment([starter]);
    using forks = holdSideChatForks();
    setup(twoPanes(), starterRef);
    await using _app = await openOwner(starter);
    await openPlusMenu("p0");

    await dragMenuItemOnto("Side chat", tabIn("p1", "diff"));
    await vi.waitFor(() => expect(forks.pending()).toBe(true));
    await vi.waitFor(() => expect(menuOpen()).toBe(false));
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("{Escape}");
    expect(voice.cancel).toHaveBeenCalledOnce();
    await forks.accept();

    // Not the drop's place before Diff: the pane's next slot, as after any other key.
    await vi.waitFor(() =>
      expect(stripOf(paneById("p1"))).toEqual(["diff", expect.stringMatching(/^thread:/)]),
    );
    expect(stripOf(paneById("p0"))).toEqual(["chat", "files"]);
  });
  it("places a dropped Side chat by a newer press in an HTML file preview when the open settles after it", async () => {
    const starter = threadWithHistory("side-chat-overtaken-file-preview", 1);
    const starterRef = scopeThreadRef(ENVIRONMENT_ID, starter.id);
    using _environment = installDragEnvironment([starter]);
    using forks = holdSideChatForks();
    setup(twoPanes(), starterRef);
    await using _app = await openOwner(starter);
    // The preview's own document gets the press; the app's window does not.
    const src = URL.createObjectURL(
      new Blob(["<label>Preview note <input></label>"], { type: "text/html" }),
    );
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
    await using preview = await render(
      <div className="fixed bottom-20 right-10 z-50 flex h-36 w-72 flex-col">
        <BrowserDocumentFrame src={src} title="Report preview" pdf={false} />
      </div>,
    );
    const frame = preview.getByTitle("Report preview");
    await expect.element(frame).toBeVisible();
    await openPlusMenu("p0");

    await dragMenuItemOnto("Side chat", tabIn("p1", "diff"));
    await vi.waitFor(() => expect(forks.pending()).toBe(true));
    await vi.waitFor(() => expect(menuOpen()).toBe(false));
    await page.frameLocator(frame).getByRole("textbox", { name: "Preview note" }).click();
    await userEvent.keyboard("x");
    expect(document.activeElement).toBe(frame.element());
    await forks.accept();

    // Not the drop's place before Diff: the pane's next slot, as after a press in the app.
    await vi.waitFor(() =>
      expect(stripOf(paneById("p1"))).toEqual(["diff", expect.stringMatching(/^thread:/)]),
    );
    expect(stripOf(paneById("p0"))).toEqual(["chat", "files"]);
  });
});
