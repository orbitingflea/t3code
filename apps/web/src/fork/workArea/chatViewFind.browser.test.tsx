import "~/index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { closeThreadFind, openThreadFind } from "~/components/chat/threadFindStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import { asPaneId, secondaryChatTabId } from "./workArea.logic";
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

async function openOwner() {
  useRightPanelStore.setState({ byThreadKey: { [scopedThreadKey(owner)]: otherChatTwice() } });
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
    expect(document.querySelectorAll("[data-work-area-pane]")).toHaveLength(3),
  );
  return stack.move();
}

const paneById = (id: string) =>
  document.querySelector<HTMLElement>(`[data-work-area-pane="${id}"]`)!;
const findIn = (id: string) =>
  page.elementLocator(paneById(id)).getByRole("searchbox", { name: "Find in thread" });
const barIn = (id: string) => paneById(id).querySelector("[data-thread-find-bar]");

const openFindFrom = (pane: string) =>
  act(() => {
    useRightPanelStore.getState().updateWorkArea(owner, { type: "focus", pane: asPaneId(pane) });
    openThreadFind(scopedThreadKey(other));
  });

it("opens Find only in the view of a Chat open in two panes that it is opened from", async () => {
  using _environment = installFakeEnvironment([ownerThread, otherThread], { threadFind: true });
  await using _app = await openOwner();
  for (const id of ["p1", "p2"]) {
    await expect
      .element(
        page
          .elementLocator(paneById(id))
          .getByRole("textbox", { name: `Message ${otherThread.title}` }),
      )
      .toBeVisible();
  }

  await openFindFrom("p2");
  await expect.element(findIn("p2")).toHaveFocus();
  expect(barIn("p1")).toBeNull();

  // A later focus on the other view leaves Find where it was opened.
  await act(() =>
    useRightPanelStore.getState().updateWorkArea(owner, { type: "focus", pane: asPaneId("p1") }),
  );
  await expect.element(findIn("p2")).toBeVisible();
  expect(barIn("p1")).toBeNull();

  // Opening it again from that view moves it there.
  await openFindFrom("p1");
  await expect.element(findIn("p1")).toHaveFocus();
  await vi.waitFor(() => expect(barIn("p2")).toBeNull());
});
