import "~/index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ORCHESTRATION_V2_WS_METHODS,
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
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import {
  asPaneId,
  holders,
  PRIMARY_CHAT,
  resolveLayout,
  secondaryChatTabId,
} from "./workArea.logic";
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

const ownerThread = threadWithHistory("find-move-owner", 1);
const otherThread = threadWithHistory("find-move-other", 1);
const thirdThread = threadWithHistory("find-move-third", 1);
const longThread = threadWithHistory("find-move-long", 28);
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);
const other = scopeThreadRef(ENVIRONMENT_ID, otherThread.id);
const third = scopeThreadRef(ENVIRONMENT_ID, thirdThread.id);
const long = scopeThreadRef(ENVIRONMENT_ID, longThread.id);
const otherChat = secondaryChatTabId(other);
const thirdChat = secondaryChatTabId(third);
const longChat = secondaryChatTabId(long);
const THREADS = [ownerThread, otherThread, thirdThread, longThread];

type PaneSpec = {
  readonly id: string;
  readonly tabs: readonly [string, ...string[]];
  readonly active?: string;
};
const paneSpec = (spec: PaneSpec) => ({
  kind: "pane" as const,
  id: spec.id,
  tabs: spec.tabs,
  active: spec.active ?? spec.tabs[0],
});

// The owner's Chat in p0 beside p1 over p2, with the other, third and long threads' Chats.
const layoutOf = (p1: PaneSpec, p2: PaneSpec) =>
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
          first: paneSpec(p1),
          second: paneSpec(p2),
        },
      },
      tabs: {
        chat: { kind: "primary-chat" },
        [otherChat]: { kind: "secondary-chat", thread: other, placement: 1 },
        [thirdChat]: { kind: "secondary-chat", thread: third, placement: 2 },
        [longChat]: { kind: "secondary-chat", thread: long, placement: 3 },
      },
      focused: "p0",
      seq: 4,
    })!,
  });

async function openOwner(record: ReturnType<typeof layoutOf>, panes: number) {
  useRightPanelStore.setState({ byThreadKey: { [scopedThreadKey(owner)]: record } });
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
  stack.defer(closeThreadFind);
  stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect
    .element(page.getByRole("textbox", { name: `Message ${ownerThread.title}` }))
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
const barIn = (id: string) => paneById(id)?.querySelector("[data-thread-find-bar]") ?? null;
const composerIn = (id: string, title = otherThread.title) =>
  page.elementLocator(paneById(id)).getByRole("textbox", { name: `Message ${title}` });
const scrollIn = (id: string) =>
  paneById(id).querySelector<HTMLElement>(".messages-timeline-scroll")!;
function visibleMessages(id: string) {
  const viewport = paneById(id).querySelector<HTMLElement>("[data-assistant-citation-viewport]")!;
  const bounds = viewport.getBoundingClientRect();
  return [...viewport.querySelectorAll<HTMLElement>('[data-timeline-row-kind="message"]')]
    .filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    })
    .flatMap((row) => row.dataset.timelineRowId ?? []);
}
const layoutNow = () =>
  resolveLayout(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, owner));
const holdersOf = (tab: string) => holders(layoutNow().root, tab as never).map((pane) => pane.id);
const openFindFrom = (pane: string, thread = other) =>
  act(() => {
    useRightPanelStore.getState().updateWorkArea(owner, { type: "focus", pane: asPaneId(pane) });
    openThreadFind(scopedThreadKey(thread));
  });
const NO_MATCHES = {
  totalMatches: 0,
  activeIndex: 0,
  snapshotSequence: 0,
  match: null,
} satisfies OrchestrationV2SearchThreadResult;

it("shows Find in the view a move of its Chat activates in a pane that held the Chat hidden", async () => {
  using _environment = installFakeEnvironment(THREADS, { threadFind: true });
  // p1 shows the other Chat; p2 holds it behind the third thread's Chat.
  await using _app = await openOwner(
    layoutOf(
      { id: "p1", tabs: [otherChat] },
      { id: "p2", tabs: [thirdChat, otherChat], active: thirdChat },
    ),
    3,
  );
  await expect.element(composerIn("p1")).toBeVisible();
  await openFindFrom("p1");
  await expect.element(findIn("p1")).toHaveFocus();

  // The tab menu's Move down: p2 already holds the Chat, so the move activates it there.
  const move = moveToward(layoutNow(), { pane: asPaneId("p1"), tab: otherChat }, "bottom")!;
  expect(move).not.toBeNull();
  await act(() => useRightPanelStore.getState().updateWorkArea(owner, move));
  await vi.waitFor(() => expect(holdersOf(otherChat)).toEqual(["p2"]));
  await expect.element(composerIn("p2")).toBeVisible();

  // Find is still open for the other thread, and its one shown view is p2's.
  await vi.waitFor(() =>
    expect({
      findThread: useThreadFindStore.getState().threadKey,
      barInP2: barIn("p2") !== null,
      bars: document.querySelectorAll("[data-thread-find-bar]").length,
    }).toEqual({ findThread: scopedThreadKey(other), barInP2: true, bars: 1 }),
  );
});

it("shows Find in wide panes after a strip drop moved every view of its Chat", async () => {
  using _environment = installFakeEnvironment(THREADS, { threadFind: true });
  await using _app = await openOwner(
    layoutOf({ id: "p1", tabs: [otherChat, thirdChat] }, { id: "p2", tabs: [otherChat] }),
    3,
  );
  await act(() =>
    useRightPanelStore.getState().updateWorkArea(owner, { type: "focus", pane: asPaneId("p1") }),
  );
  await page.viewport(940, 900);
  await vi.waitFor(() =>
    expect(document.querySelectorAll("[data-work-area-pane]")).toHaveLength(1),
  );
  await expect.element(composerIn("p1")).toBeVisible();
  await openFindFrom("p1");
  await expect.element(findIn("p1")).toHaveFocus();

  // A drop in the strip before the main Chat's tab moves the tab: both views leave for p0.
  await act(() =>
    useRightPanelStore.getState().updateWorkArea(owner, {
      type: "place",
      source: { view: { pane: asPaneId("p1"), tab: otherChat } },
      at: { kind: "strip", pane: asPaneId("p0"), before: PRIMARY_CHAT },
    }),
  );
  await vi.waitFor(() => expect(holdersOf(otherChat)).toEqual(["p0"]));
  await expect.element(composerIn("p0")).toBeVisible();
  await expect.element(findIn("p0")).toBeVisible();

  // The window is wide again: p0 shows the other Chat beside p1.
  await page.viewport(1400, 900);
  await vi.waitFor(() =>
    expect(document.querySelectorAll("[data-work-area-pane]").length).toBeGreaterThan(1),
  );
  await expect.element(composerIn("p0")).toBeVisible();
  await vi.waitFor(() =>
    expect({
      findThread: useThreadFindStore.getState().threadKey,
      barInP0: barIn("p0") !== null,
    }).toEqual({ findThread: scopedThreadKey(other), barInP0: true }),
  );
});

it("restarts a search from the view where Ctrl+F asks for Find again", async () => {
  using _environment = installFakeEnvironment(THREADS, {
    threadFind: true,
    keybindings: compileResolvedKeybindingsConfig([{ key: "ctrl+f", command: "chat.find" }]),
  });
  const searches: OrchestrationV2SearchThreadInput[] = [];
  using _search = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.searchThread,
    (input: OrchestrationV2SearchThreadInput) => {
      searches.push(input);
      return Effect.succeed(NO_MATCHES);
    },
  );
  await using _app = await openOwner(
    layoutOf({ id: "p1", tabs: [longChat] }, { id: "p2", tabs: [longChat] }),
    3,
  );
  for (const id of ["p1", "p2"])
    await expect.element(composerIn(id, longThread.title)).toBeVisible();
  await vi.waitFor(
    () => {
      expect(scrollIn("p1").scrollTop).toBeGreaterThan(1200);
      expect(scrollIn("p2").scrollTop).toBeGreaterThan(1200);
    },
    { timeout: 5000 },
  );
  // p1 goes back to the first turns; p2 stays at the newest.
  await userEvent.wheel(scrollIn("p1"), { delta: { y: -10000 } });
  await vi.waitFor(() => {
    expect(scrollIn("p1").scrollTop).toBeLessThan(100);
    expect(visibleMessages("p1").length).toBeGreaterThan(0);
    expect(visibleMessages("p2").length).toBeGreaterThan(0);
  });
  const inP1 = visibleMessages("p1");
  const inP2 = visibleMessages("p2");
  expect(inP1.filter((id) => inP2.includes(id))).toEqual([]);

  scrollIn("p1").focus();
  await userEvent.keyboard("{Control>}f{/Control}");
  await expect.element(findIn("p1")).toHaveFocus();
  await findIn("p1").fill("question");
  await vi.waitFor(() => expect(searches.length).toBeGreaterThan(0));
  const first = searches.at(-1)?.start?.entryId ?? "";
  expect(inP1.includes(first)).toBe(true);

  // The user goes to p2's message box and presses Ctrl+F there: Find moves to p2 and restarts.
  const box = composerIn("p2", longThread.title).element();
  if (!(box instanceof HTMLElement)) throw new Error("Expected a message box");
  await act(() => box.focus());
  await vi.waitFor(() => expect(layoutNow().focused).toBe("p2"));
  const before = searches.length;
  await userEvent.keyboard("{Control>}f{/Control}");
  await expect.element(findIn("p2")).toHaveFocus();
  expect(barIn("p1")).toBeNull();
  await vi.waitFor(() => expect(searches.length).toBeGreaterThan(before));
  const restart = searches.at(-1)?.start?.entryId ?? "";
  expect({
    anchorInP2: visibleMessages("p2").includes(restart),
    anchorInP1: inP1.includes(restart),
  }).toEqual({ anchorInP2: true, anchorInP1: false });
});
