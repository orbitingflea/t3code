import "~/index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { MessageId, ORCHESTRATION_V2_WS_METHODS, TurnItemId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { CHAT_REPLIES_DISPLAY_MODE } from "@t3tools/shared/displayModes";
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
import { useRightPanelStore } from "~/rightPanelStore";
import {
  answerRpc,
  assistantItem,
  ENVIRONMENT_ID,
  type FakeDriver,
  installFakeEnvironment,
  threadWithHistory,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";
import { replyContextField } from "../subThreads/subThreadReply";
import { asPaneId, replyTabId, secondaryChatTabId } from "./workArea.logic";
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

// A thread whose agent message starts a sub-thread with one reply, as subThreadCite's tests build it.
function threadWithAgentSubThread(name: string) {
  const history = threadWithHistory(name, 1);
  const id = `${name}-news`;
  const {
    messageId: _id,
    text: _text,
    streaming: _streaming,
    ...item
  } = assistantItem(history.id, history.runs[0]!.id, id, 2, "");
  const news = {
    ...item,
    type: "dynamic_tool" as const,
    toolName: "mcp__t3-code__send_to_user",
    input: { text: "The deploy is done.", new_sub_thread: true },
    output: { ok: true },
  };
  const reply = {
    ...item,
    id: TurnItemId.make(`${id}-reply`),
    ordinal: 3,
    type: "user_message" as const,
    messageId: MessageId.make(`${id}-reply`),
    text: "Which deploy?",
    attachments: [],
    inputIntent: "turn_start" as const,
    createdBy: "user" as const,
    creationSource: "web" as const,
    ...replyContextField(news.id),
  };
  return { thread: { ...history, items: [...history.items, news, reply] }, first: news.id };
}

const ownerThread = threadWithHistory("find-reply-owner", 1);
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);
const withReply = threadWithAgentSubThread("find-reply-other");
const otherThread = withReply.thread;
const other = scopeThreadRef(ENVIRONMENT_ID, otherThread.id);
const otherChat = secondaryChatTabId(other);
const reply = replyTabId(other, withReply.first);
// Every test serves the same threads and settings: the app keeps the first test's config.
const THREADS = [ownerThread, otherThread];
const settings = { threadDisplayModes: { [otherThread.id]: CHAT_REPLIES_DISPLAY_MODE.id } };

type PaneSpec = { readonly id: string; readonly tab: string };
const paneOf = (spec: PaneSpec) => ({
  kind: "pane" as const,
  id: spec.id,
  tabs: [spec.tab],
  active: spec.tab,
});

// The owner's Chat in p0 beside the given panes, stacked in a column.
const chatBeside = (right: readonly [PaneSpec] | readonly [PaneSpec, PaneSpec]) =>
  restoredRecord({
    isOpen: false,
    activeSurfaceId: null,
    surfaces: [],
    workArea: restoreWorkArea({
      root: {
        kind: "split",
        id: "s2",
        axis: "row",
        ratio: 0.4,
        first: { kind: "pane", id: "p0", tabs: ["chat"], active: "chat" },
        second:
          right.length === 1
            ? paneOf(right[0])
            : {
                kind: "split",
                id: "s3",
                axis: "column",
                ratio: 0.5,
                first: paneOf(right[0]),
                second: paneOf(right[1]),
              },
      },
      tabs: {
        chat: { kind: "primary-chat" },
        [otherChat]: { kind: "secondary-chat", thread: other, placement: 1 },
        [reply]: { kind: "sub-thread", thread: other, first: withReply.first },
      },
      focused: "p0",
      seq: 4,
    })!,
  });

async function openOwner(record: ReturnType<typeof chatBeside>, panes: number) {
  useRightPanelStore.setState({ byThreadKey: { [scopedThreadKey(owner)]: record } });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1600, 900);
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
const replyView = () =>
  document.querySelector<HTMLElement>(`[data-sub-thread-view="${withReply.first}"]`);
const openFindFrom = (pane: string) =>
  act(() => {
    useRightPanelStore.getState().updateWorkArea(owner, { type: "focus", pane: asPaneId(pane) });
    openThreadFind(scopedThreadKey(other));
  });

it.each([
  { chat: "p1", replies: "p2", order: "a later pane" },
  { chat: "p2", replies: "p1", order: "an earlier pane" },
])(
  "shows Find in a Chat's one view while a reply of that Chat is open in $order",
  async ({ chat, replies }) => {
    using _environment = installFakeEnvironment(THREADS, { threadFind: true, settings });
    await using _app = await openOwner(
      chatBeside([
        { id: "p1", tab: chat === "p1" ? otherChat : reply },
        { id: "p2", tab: chat === "p2" ? otherChat : reply },
      ]),
      3,
    );
    await expect
      .element(
        page
          .elementLocator(paneById(chat))
          .getByRole("textbox", { name: `Message ${otherThread.title}` }),
      )
      .toBeVisible();
    await vi.waitFor(() => expect(paneById(replies).contains(replyView())).toBe(true));

    await openFindFrom(chat);

    await expect.element(findIn(chat)).toHaveFocus();
    expect(document.querySelectorAll("[data-thread-find-bar]")).toHaveLength(1);
  },
);

it("marks the match in a reply that a Find step from a Chat's one view opens in another pane", async () => {
  using _environment = installFakeEnvironment(THREADS, { threadFind: true, settings });
  const runId = otherThread.runs[0]!.id;
  const entries = [withReply.first, `${withReply.first}-reply`];
  using _search = answerRpc(ORCHESTRATION_V2_WS_METHODS.searchThread, () =>
    Effect.succeed({
      complete: true,
      snapshotSequence: 0,
      totalMatches: 2,
      activeIndex: 0,
      match: { entryId: entries[0]!, runId, occurrence: 0 },
      navigation: entries.map((entryId, startIndex) => ({ entryId, runId, startIndex, count: 1 })),
    }),
  );
  await using _app = await openOwner(chatBeside([{ id: "p1", tab: otherChat }]), 2);
  await expect
    .element(
      page
        .elementLocator(paneById("p1"))
        .getByRole("textbox", { name: `Message ${otherThread.title}` }),
    )
    .toBeVisible();
  await openFindFrom("p1");
  await expect.element(findIn("p1")).toHaveFocus();
  await userEvent.type(findIn("p1"), "deploy");
  const count = () => paneById("p1").querySelector('[role="search"]')?.textContent ?? "";
  const highlights = (name: string) => CSS.highlights.get(name)?.size ?? 0;
  await vi.waitFor(() => expect(count()).toMatch(/\b1\b.*\b2\b/));
  await vi.waitFor(() => expect(highlights("t3-thread-find-active")).toBe(1));

  // The next match is the reply's, which opens in its own pane.
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(replyView()?.checkVisibility()).toBe(true));
  await vi.waitFor(() => expect(count()).toMatch(/\b2\b.*\b2\b/));

  await vi.waitFor(() => expect(highlights("t3-sub-thread-find-active")).toBe(1));
  expect(paneById("p1").querySelector("[data-thread-find-bar]")).not.toBeNull();
});
