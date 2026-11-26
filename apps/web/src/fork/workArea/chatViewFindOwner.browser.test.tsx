import "~/index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  type OrchestrationV2SearchThreadInput,
  type OrchestrationV2SearchThreadResult,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import {
  closeThreadFind,
  openThreadFind,
  useThreadFindStore,
} from "~/components/chat/threadFindStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import {
  answerRpc,
  assistantItem,
  emitThreadEvent,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import { asPaneId, holders, resolveLayout, secondaryChatTabId } from "./workArea.logic";
import { moveToward } from "./workAreaPlacement.logic";
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

const ownerThread = threadWithHistory("find-owner-owner", 1);
const longOwnerThread = threadWithHistory("find-owner-long-owner", 28);
const otherThread = threadWithHistory("find-owner-other", 1);
const thirdThread = threadWithHistory("find-owner-third", 1);
const longThread = threadWithHistory("find-owner-long", 28);
const other = scopeThreadRef(ENVIRONMENT_ID, otherThread.id);
const third = scopeThreadRef(ENVIRONMENT_ID, thirdThread.id);
const long = scopeThreadRef(ENVIRONMENT_ID, longThread.id);
const otherChat = secondaryChatTabId(other);
const thirdChat = secondaryChatTabId(third);
const longChat = secondaryChatTabId(long);
const THREADS = [ownerThread, longOwnerThread, otherThread, thirdThread, longThread];
const FIND_KEYS = compileResolvedKeybindingsConfig([{ key: "ctrl+f", command: "chat.find" }]);
const NO_MATCHES = {
  totalMatches: 0,
  activeIndex: 0,
  snapshotSequence: 0,
  match: null,
} satisfies OrchestrationV2SearchThreadResult;

type Node =
  | { readonly kind: "pane"; readonly id: string; readonly tabs: string[]; readonly active: string }
  | {
      readonly kind: "split";
      readonly id: string;
      readonly axis: "row" | "column";
      readonly ratio: number;
      readonly first: Node;
      readonly second: Node;
    };
const pane = (id: string, tabs: string[], active = tabs[0]!): Node => ({
  kind: "pane",
  id,
  tabs,
  active,
});
let splits = 10;
const split =
  (axis: "row" | "column") =>
  (first: Node, second: Node): Node => ({
    kind: "split",
    id: `s${(splits += 1)}`,
    axis,
    ratio: 0.5,
    first,
    second,
  });
const row = split("row");
const column = split("column");

const recordOf = (root: Node, focused: string) =>
  restoredRecord({
    isOpen: false,
    activeSurfaceId: null,
    surfaces: [],
    workArea: restoreWorkArea({
      root,
      tabs: {
        chat: { kind: "primary-chat" },
        [otherChat]: { kind: "secondary-chat", thread: other, placement: 1 },
        [thirdChat]: { kind: "secondary-chat", thread: third, placement: 2 },
        [longChat]: { kind: "secondary-chat", thread: long, placement: 3 },
      },
      focused,
      seq: 20,
    })!,
  });

let routeOwner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);

async function openOwner(
  ownerId: typeof ownerThread,
  record: ReturnType<typeof recordOf>,
  panes: number,
) {
  routeOwner = scopeThreadRef(ENVIRONMENT_ID, ownerId.id);
  useRightPanelStore.setState({ byThreadKey: { [scopedThreadKey(routeOwner)]: record } });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${ownerId.id}`] }),
  );
  await router.load();
  await using stack = new AsyncDisposableStack();
  stack.defer(closeThreadFind);
  stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect
    .element(page.getByRole("textbox", { name: `Message ${ownerId.title}` }))
    .toBeVisible();
  await vi.waitFor(() =>
    expect(document.querySelectorAll("[data-work-area-pane]")).toHaveLength(panes),
  );
  return stack.move();
}

const paneById = (id: string) =>
  document.querySelector<HTMLElement>(`[data-work-area-pane="${id}"]`)!;
const findIn = (id: string) =>
  page.elementLocator(paneById(id)).getByRole("searchbox", { name: "Find in thread" });
const barPanes = () =>
  [...document.querySelectorAll("[data-thread-find-bar]")].map(
    (bar) => bar.closest("[data-work-area-pane]")?.getAttribute("data-work-area-pane") ?? "main",
  );
const composerIn = (id: string, title: string) =>
  page.elementLocator(paneById(id)).getByRole("textbox", { name: `Message ${title}` });
const scrollIn = (id: string) =>
  paneById(id).querySelector<HTMLElement>(".messages-timeline-scroll")!;
const mainScroll = () =>
  [...document.querySelectorAll<HTMLElement>(".messages-timeline-scroll")].find(
    (element) => element.closest("[data-work-area-pane]") === null,
  )!;
function visibleIn(viewport: HTMLElement) {
  const bounds = viewport.getBoundingClientRect();
  return [...viewport.querySelectorAll<HTMLElement>('[data-timeline-row-kind="message"]')]
    .filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    })
    .flatMap((row) => row.dataset.timelineRowId ?? []);
}
const visibleMessages = (id: string) =>
  visibleIn(paneById(id).querySelector<HTMLElement>("[data-assistant-citation-viewport]")!);
const visibleMain = () =>
  visibleIn(
    [...document.querySelectorAll<HTMLElement>("[data-assistant-citation-viewport]")].find(
      (element) => element.closest("[data-work-area-pane]") === null,
    )!,
  );
const layoutNow = () =>
  resolveLayout(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, routeOwner));
const holdersOf = (tab: string) => holders(layoutNow().root, tab as never).map((p) => p.id);

it("shows Find in the view a move activates when a third copy of the Chat is shown", async () => {
  using _environment = installFakeEnvironment(THREADS, { threadFind: true });
  // p0 main Chat over p3 (the other Chat, shown); p1 the other Chat over p2 (it, hidden).
  await using _app = await openOwner(
    ownerThread,
    recordOf(
      row(
        column(pane("p0", ["chat"]), pane("p3", [otherChat])),
        column(pane("p1", [otherChat]), pane("p2", [thirdChat, otherChat], thirdChat)),
      ),
      "p0",
    ),
    4,
  );
  await expect.element(composerIn("p1", otherThread.title)).toBeVisible();
  await expect.element(composerIn("p3", otherThread.title)).toBeVisible();
  await act(() => {
    useRightPanelStore
      .getState()
      .updateWorkArea(routeOwner, { type: "focus", pane: asPaneId("p1") });
    openThreadFind(scopedThreadKey(other));
  });
  await expect.element(findIn("p1")).toHaveFocus();
  expect(barPanes()).toEqual(["p1"]);

  // The tab menu's Move down: p2 holds the Chat hidden, so the move activates it there.
  const move = moveToward(layoutNow(), { pane: asPaneId("p1"), tab: otherChat }, "bottom")!;
  expect(move).not.toBeNull();
  await act(() => useRightPanelStore.getState().updateWorkArea(routeOwner, move));
  await vi.waitFor(() => expect(holdersOf(otherChat)).toEqual(["p3", "p2"]));
  await expect.element(composerIn("p2", otherThread.title)).toBeVisible();
  await vi.waitFor(() =>
    expect({
      findThread: useThreadFindStore.getState().threadKey,
      focused: layoutNow().focused,
      bars: barPanes(),
    }).toEqual({ findThread: scopedThreadKey(other), focused: "p2", bars: ["p2"] }),
  );
});

it("keeps a side Chat's Find start when the main Chat gets a new message", async () => {
  using _environment = installFakeEnvironment(THREADS, {
    threadFind: true,
    keybindings: FIND_KEYS,
  });
  using _search = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.searchThread,
    (_input: OrchestrationV2SearchThreadInput) => Effect.succeed(NO_MATCHES),
  );
  await using _app = await openOwner(
    ownerThread,
    recordOf(row(pane("p0", ["chat"]), pane("p1", [longChat])), "p0"),
    2,
  );
  await expect.element(composerIn("p1", longThread.title)).toBeVisible();
  await vi.waitFor(() => expect(scrollIn("p1").scrollTop).toBeGreaterThan(1200), {
    timeout: 5000,
  });
  await userEvent.wheel(scrollIn("p1"), { delta: { y: -10000 } });
  await vi.waitFor(() => expect(scrollIn("p1").scrollTop).toBeLessThan(100));
  await userEvent.click(composerIn("p1", longThread.title));
  await userEvent.keyboard("{Control>}f{/Control}");
  await expect.element(findIn("p1")).toHaveFocus();
  const before = visibleMessages("p1");
  expect(before.length).toBeGreaterThan(0);
  await findIn("p1").fill("question");
  const first = useThreadFindStore.getState().start?.entryId ?? null;

  const message = "The main Chat just got a new message.";
  const item = assistantItem(
    ownerThread.id,
    RunId.make("find-owner-owner-run-0"),
    "find-owner-owner-new",
    6,
    message,
  );
  await act(() => emitThreadEvent(ownerThread.id, { type: "turn-item.updated", payload: item }));
  await expect.element(page.getByText(message)).toBeVisible();
  const after = visibleMessages("p1");

  await findIn("p1").fill("answer");
  const second = useThreadFindStore.getState().start?.entryId ?? null;
  const result = {
    firstInView: first !== null && before.includes(first),
    viewKept: after.join() === before.join(),
    secondInView: second !== null && after.includes(second),
    second,
  };
  expect(result).toMatchObject({ firstInView: true, viewKept: true, secondInView: true });
});

it("keeps the main Chat's Find start when a side Chat in a pane gets a new message", async () => {
  using _environment = installFakeEnvironment(THREADS, {
    threadFind: true,
    keybindings: FIND_KEYS,
  });
  using _search = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.searchThread,
    (_input: OrchestrationV2SearchThreadInput) => Effect.succeed(NO_MATCHES),
  );
  await using _app = await openOwner(
    longOwnerThread,
    recordOf(row(pane("p0", ["chat"]), pane("p1", [otherChat])), "p0"),
    2,
  );
  await expect.element(composerIn("p1", otherThread.title)).toBeVisible();
  await vi.waitFor(() => expect(mainScroll().scrollTop).toBeGreaterThan(1200), {
    timeout: 5000,
  });
  await userEvent.wheel(mainScroll(), { delta: { y: -10000 } });
  await vi.waitFor(() => expect(mainScroll().scrollTop).toBeLessThan(100));
  await userEvent.click(page.getByRole("textbox", { name: `Message ${longOwnerThread.title}` }));
  await userEvent.keyboard("{Control>}f{/Control}");
  const field = page.getByRole("searchbox", { name: "Find in thread" });
  await expect.element(field).toHaveFocus();
  const before = visibleMain();
  expect(before.length).toBeGreaterThan(0);
  await field.fill("question");
  const first = useThreadFindStore.getState().start?.entryId ?? null;

  const message = "The side Chat just got a new message.";
  const item = assistantItem(
    otherThread.id,
    RunId.make("find-owner-other-run-0"),
    "find-owner-other-new",
    6,
    message,
  );
  await act(() => emitThreadEvent(otherThread.id, { type: "turn-item.updated", payload: item }));
  await expect.element(page.getByText(message)).toBeVisible();
  const after = visibleMain();

  await field.fill("answer");
  const second = useThreadFindStore.getState().start?.entryId ?? null;
  const result = {
    firstInView: first !== null && before.includes(first),
    viewKept: after.join() === before.join(),
    secondInView: second !== null && after.includes(second),
    second,
  };
  expect(result).toMatchObject({ firstInView: true, viewKept: true, secondInView: true });
});
