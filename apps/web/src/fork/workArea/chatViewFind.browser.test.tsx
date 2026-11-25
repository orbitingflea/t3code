import "~/index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2SearchThreadInput,
  type OrchestrationV2SearchThreadResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { closeThreadFind, openThreadFind } from "~/components/chat/threadFindStore";
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

const ownerThread = threadWithHistory("find-owner", 1);
const otherThread = threadWithHistory("find-other", 1);
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);
const other = scopeThreadRef(ENVIRONMENT_ID, otherThread.id);
const otherChat = secondaryChatTabId(other);
// Long enough that a view scrolled to its first turns shows none of the newest.
const longThread = threadWithHistory("find-long", 28);
const long = scopeThreadRef(ENVIRONMENT_ID, longThread.id);
const longChat = secondaryChatTabId(long);
// Every test serves the same threads, so a thread first shown in a later test still loads.
const THREADS = [ownerThread, otherThread, longThread];

type PaneSpec = { readonly id: string; readonly tabs: readonly [string, ...string[]] };
const paneSpec = (spec: PaneSpec) => ({
  kind: "pane" as const,
  id: spec.id,
  tabs: spec.tabs,
  active: spec.tabs[0],
});

// The owner's Chat in p0 beside the given panes, stacked in a column, with `thread`'s Chat.
const chatBeside = (
  right: readonly [PaneSpec] | readonly [PaneSpec, PaneSpec],
  thread: ScopedThreadRef = other,
) =>
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
        second:
          right.length === 1
            ? paneSpec(right[0])
            : {
                kind: "split",
                id: "s3",
                axis: "column",
                ratio: 0.5,
                first: paneSpec(right[0]),
                second: paneSpec(right[1]),
              },
      },
      tabs: {
        chat: { kind: "primary-chat" },
        [secondaryChatTabId(thread)]: { kind: "secondary-chat", thread, placement: 1 },
      },
      focused: "p0",
      seq: 4,
    })!,
  });

// The other thread's Chat in p1 and in p2 below it.
const otherChatTwice = () =>
  chatBeside([
    { id: "p1", tabs: [otherChat] },
    { id: "p2", tabs: [otherChat] },
  ]);

async function openOwner(record: ReturnType<typeof chatBeside>, panes: number) {
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
  // AppRoot brings its own router.
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
const barIn = (id: string) => paneById(id).querySelector("[data-thread-find-bar]");
const composerIn = (id: string, title = otherThread.title) =>
  page.elementLocator(paneById(id)).getByRole("textbox", { name: `Message ${title}` });
const scrollIn = (id: string) =>
  paneById(id).querySelector<HTMLElement>(".messages-timeline-scroll")!;
// The message rows a view's timeline shows on screen.
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
const holdersOfOther = () => holders(layoutNow().root, otherChat).map((pane) => pane.id);

const focusPane = (pane: string) =>
  act(() =>
    useRightPanelStore.getState().updateWorkArea(owner, { type: "focus", pane: asPaneId(pane) }),
  );
const openFindFrom = (pane: string) =>
  act(() => {
    useRightPanelStore.getState().updateWorkArea(owner, { type: "focus", pane: asPaneId(pane) });
    openThreadFind(scopedThreadKey(other));
  });

it("opens Find only in the view of a Chat open in two panes that it is opened from", async () => {
  using _environment = installFakeEnvironment(THREADS, { threadFind: true });
  await using _app = await openOwner(otherChatTwice(), 3);
  for (const id of ["p1", "p2"]) await expect.element(composerIn(id)).toBeVisible();

  await openFindFrom("p2");
  await expect.element(findIn("p2")).toHaveFocus();
  expect(barIn("p1")).toBeNull();

  // Find shows in the view the user turns to.
  await focusPane("p1");
  await expect.element(findIn("p1")).toBeVisible();
  await vi.waitFor(() => expect(barIn("p2")).toBeNull());

  // Opening it again from the other view moves it back there.
  await openFindFrom("p2");
  await expect.element(findIn("p2")).toHaveFocus();
  await vi.waitFor(() => expect(barIn("p1")).toBeNull());
});

it("keeps Find open in a Chat shown once after its one view moves to another pane", async () => {
  using _environment = installFakeEnvironment(THREADS, { threadFind: true });
  await using _app = await openOwner(chatBeside([{ id: "p1", tabs: [otherChat] }]), 2);
  await expect.element(composerIn("p1")).toBeVisible();
  await openFindFrom("p1");
  await expect.element(findIn("p1")).toHaveFocus();

  // The tab menu's Move left: the Chat's one view joins p0.
  const move = moveToward(layoutNow(), { pane: asPaneId("p1"), tab: otherChat }, "left")!;
  await act(() => useRightPanelStore.getState().updateWorkArea(owner, move));
  await vi.waitFor(() => expect(holdersOfOther()).toEqual(["p0"]));
  await expect.element(composerIn("p0")).toBeVisible();

  await expect.element(findIn("p0")).toBeVisible();
});

it("shows Find in the view left after the view it was opened in closes", async () => {
  using _environment = installFakeEnvironment(THREADS, { threadFind: true });
  await using _app = await openOwner(otherChatTwice(), 3);
  await openFindFrom("p2");
  await expect.element(findIn("p2")).toHaveFocus();
  expect(barIn("p1")).toBeNull();

  // Close p2's view of the Chat, as its tab's X does: the other view stays.
  await act(() =>
    useRightPanelStore.getState().updateWorkArea(owner, {
      type: "close-view",
      view: { pane: asPaneId("p2"), tab: otherChat },
    }),
  );
  await vi.waitFor(() => expect(holdersOfOther()).toEqual(["p1"]));

  await expect.element(findIn("p1")).toBeVisible();
});

it("keeps Find open in the one strip when a drop moves its Chat to another pane", async () => {
  using _environment = installFakeEnvironment(THREADS, { threadFind: true });
  await using _app = await openOwner(chatBeside([{ id: "p1", tabs: [otherChat] }]), 2);
  await focusPane("p1");
  await page.viewport(940, 900);
  await vi.waitFor(() =>
    expect(document.querySelectorAll("[data-work-area-pane]")).toHaveLength(1),
  );
  await expect.element(composerIn("p1")).toBeVisible();
  await openFindFrom("p1");
  await expect.element(findIn("p1")).toHaveFocus();

  // A drop in the strip before the main Chat's tab puts the other Chat's view in p0.
  await act(() =>
    useRightPanelStore.getState().updateWorkArea(owner, {
      type: "place",
      source: { view: { pane: asPaneId("p1"), tab: otherChat } },
      at: { kind: "strip", pane: asPaneId("p0"), before: PRIMARY_CHAT },
    }),
  );
  await vi.waitFor(() => expect(holdersOfOther()).toEqual(["p0"]));
  await expect.element(composerIn("p0")).toBeVisible();

  await expect.element(findIn("p0")).toBeVisible();
});

it("starts a search from the viewport of the view that shows Find", async () => {
  using _environment = installFakeEnvironment(THREADS, {
    threadFind: true,
    keybindings: compileResolvedKeybindingsConfig([{ key: "ctrl+f", command: "chat.find" }]),
  });
  const searches: OrchestrationV2SearchThreadInput[] = [];
  using _search = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.searchThread,
    (input: OrchestrationV2SearchThreadInput) => {
      searches.push(input);
      return Effect.succeed({
        totalMatches: 0,
        activeIndex: 0,
        snapshotSequence: 0,
        match: null,
      } satisfies OrchestrationV2SearchThreadResult);
    },
  );
  await using _app = await openOwner(
    chatBeside(
      [
        { id: "p1", tabs: [longChat] },
        { id: "p2", tabs: [longChat] },
      ],
      long,
    ),
    3,
  );
  for (const id of ["p1", "p2"])
    await expect.element(composerIn(id, longThread.title)).toBeVisible();
  // Both views open at the newest turns; p1 goes back to the first ones.
  await vi.waitFor(
    () => {
      expect(scrollIn("p1").scrollTop).toBeGreaterThan(1200);
      expect(scrollIn("p2").scrollTop).toBeGreaterThan(1200);
    },
    { timeout: 5000 },
  );
  await userEvent.wheel(scrollIn("p1"), { delta: { y: -10000 } });
  await vi.waitFor(() => {
    expect(scrollIn("p1").scrollTop).toBeLessThan(100);
    expect(visibleMessages("p1").length).toBeGreaterThan(0);
    expect(visibleMessages("p2").length).toBeGreaterThan(0);
  });
  scrollIn("p1").focus();
  await userEvent.keyboard("{Control>}f{/Control}");
  await expect.element(findIn("p1")).toHaveFocus();
  expect(barIn("p2")).toBeNull();
  const shown = visibleMessages("p1");
  expect(shown.filter((id) => visibleMessages("p2").includes(id))).toEqual([]);

  await findIn("p1").fill("question");

  await vi.waitFor(() => expect(searches.length).toBeGreaterThan(0));
  expect(shown).toContain(searches.at(-1)?.start?.entryId);
});
