import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { MessageId, ORCHESTRATION_V2_WS_METHODS, TurnItemId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { CHAT_REPLIES_DISPLAY_MODE } from "@t3tools/shared/displayModes";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { openThreadFind } from "~/components/chat/threadFindStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import stylesheet from "~/index.css?inline";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import {
  answerRpc,
  assistantItem,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { paneHolding, replyTabId, resolveLayout, type TabId } from "../workArea/workArea.logic";
import { replyContextField, subThreadDraftId } from "./subThreadReply";

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

/** An agent message that opens a sub-thread, and the user's reply in it. */
function agentSubThread(
  history: ReturnType<typeof threadWithHistory>,
  id: string,
  ordinal: number,
  text: string,
) {
  const {
    messageId: _id,
    text: _text,
    streaming: _streaming,
    ...item
  } = assistantItem(history.id, history.runs[0]!.id, id, ordinal, "");
  const news = {
    ...item,
    type: "dynamic_tool" as const,
    toolName: "mcp__t3-code__send_to_user",
    input: { text, new_sub_thread: true },
    output: { ok: true },
  };
  // Only a message that already has replies takes a main-list Cite into its Replies.
  const reply = {
    ...item,
    id: TurnItemId.make(`${id}-reply`),
    ordinal: ordinal + 1,
    type: "user_message" as const,
    messageId: MessageId.make(`${id}-reply`),
    text: "Which deploy?",
    attachments: [],
    inputIntent: "turn_start" as const,
    createdBy: "user" as const,
    creationSource: "web" as const,
    ...replyContextField(news.id),
  };
  return { items: [news, reply], first: news.id };
}

function threadWithAgentSubThread(name: string) {
  const history = threadWithHistory(name, 1);
  const news = agentSubThread(history, `${name}-news`, 2, "The deploy is done.");
  return { thread: { ...history, items: [...history.items, ...news.items] }, first: news.first };
}

function threadWithTwoSubThreads(name: string) {
  const history = threadWithHistory(name, 1);
  const deploy = agentSubThread(history, `${name}-deploy`, 2, "The deploy is done.");
  const tests = agentSubThread(history, `${name}-tests`, 4, "The tests pass.");
  return {
    thread: { ...history, items: [...history.items, ...deploy.items, ...tests.items] },
    firsts: [deploy.first, tests.first] as const,
  };
}

const layouts = {
  "side panel": { width: 1194, ...threadWithAgentSubThread("cite-side-panel") },
  sheet: { width: 414, ...threadWithAgentSubThread("cite-sheet") },
};
const findInStrip = threadWithAgentSubThread("find-strip");
const twoReplies = threadWithTwoSubThreads("two-replies");
const threads = [
  ...Object.values(layouts).map((layout) => layout.thread),
  findInStrip.thread,
  twoReplies.thread,
];
const settings = {
  threadDisplayModes: Object.fromEntries(
    threads.map((thread) => [thread.id, CHAT_REPLIES_DISPLAY_MODE.id]),
  ),
};

// One server config for every case: the app keeps the first case's config for the whole file.
const installEnvironment = () => installFakeEnvironment(threads, { settings, threadFind: true });

const waitForChatRepliesMode = () =>
  expect.element(page.getByRole("button", { name: /1 reply/ }).first()).toBeInTheDocument();

const selectWithPointer = (text: string) => userEvent.tripleClick(page.getByText(text));

async function openThread(threadId: string, width: number) {
  // The work area places reply tabs by its laid-out size.
  const style = document.createElement("style");
  style.textContent = stylesheet;
  document.head.append(style);
  await using stack = new AsyncDisposableStack();
  stack.defer(() => style.remove());
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(width, 834);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threadId}`] }),
  );
  await router.load();
  // AppRoot brings its own router.
  stack.use(await render(<AppRoot router={router} />, { router: false }));
  await waitForChatRepliesMode();
  return stack.move();
}

it.each(Object.keys(layouts) as Array<keyof typeof layouts>)(
  "a Cite in the main list opens the replies of a message that has some in the %s, adds the quote to the saved reply draft and opens its comment box with focus",
  async (layout) => {
    const { width, thread, first } = layouts[layout];
    const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
    const replyDraft = subThreadDraftId(scopedThreadKey(threadRef), first)!;
    using _environment = installEnvironment();
    useComposerDraftStore.getState().setPrompt(replyDraft, "saved note");
    await using _app = await openThread(thread.id, width);
    await selectWithPointer("The deploy is done.");
    await page.getByRole("button", { name: "Cite selection in composer" }).click();

    const comment = page.getByLabelText("Comment on selected text");
    await expect.element(comment).toBeInTheDocument();
    expect(document.querySelector(`[data-sub-thread-view="${first}"]`)).not.toBeNull();
    const tab = document.querySelector(
      `[data-right-panel-tab-id="${CSS.escape(replyTabId(threadRef, first))}"]`,
    );
    expect(tab?.textContent).toContain("The deploy is done.");
    await vi.waitFor(() => expect(document.querySelector("[data-starting-style]")).toBeNull());
    await userEvent.keyboard("why?");
    await expect.element(comment).toHaveValue("why?");
    const reply = useComposerDraftStore.getState().getComposerDraft(replyDraft)?.prompt ?? "";
    expect(reply).toContain("saved note");
    expect(
      collectAssistantCitations(reply).map(({ citation }) => [citation.messageId, citation.text]),
    ).toEqual([[first, "The deploy is done."]]);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "").toBe("");
  },
);

it("steps Find between a main match and a reply match in the one strip, keeping the Find field focused", async () => {
  const threadRef = scopeThreadRef(ENVIRONMENT_ID, findInStrip.thread.id);
  using _environment = installEnvironment();
  const runId = findInStrip.thread.runs[0]!.id;
  const entries = [findInStrip.first, `${findInStrip.first}-reply`];
  const found = {
    complete: true,
    snapshotSequence: 0,
    totalMatches: 2,
    activeIndex: 0,
    match: { entryId: entries[0]!, runId, occurrence: 0 },
    navigation: entries.map((entryId, startIndex) => ({ entryId, runId, startIndex, count: 1 })),
  };
  using _search = answerRpc(ORCHESTRATION_V2_WS_METHODS.searchThread, () => Effect.succeed(found));
  await using _app = await openThread(findInStrip.thread.id, 414);
  openThreadFind(scopedThreadKey(threadRef));
  const field = page.getByRole("searchbox", { name: "Find in thread" });
  await expect.element(field).toBeVisible();
  await userEvent.type(field, "deploy");
  const search = () => document.querySelector('[role="search"]')?.textContent ?? "";
  await vi.waitFor(() => expect(search()).toMatch(/\b1\b.*\b2\b/));
  const replyView = () =>
    document.querySelector<HTMLElement>(`[data-sub-thread-view="${findInStrip.first}"]`);
  const column = () => document.querySelector<HTMLElement>("[data-chat-column]")!;
  const activeMatch = (highlight: string) => CSS.highlights.get(highlight)?.size ?? 0;
  const onTop = (element: Element) => {
    const box = element.getBoundingClientRect();
    return element.contains(
      document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
    );
  };

  for (const [key, shows, count] of [
    ["{Enter}", "reply", /\b2\b.*\b2\b/],
    ["{Shift>}{Enter}{/Shift}", "chat", /\b1\b.*\b2\b/],
    ["{Enter}", "reply", /\b2\b.*\b2\b/],
  ] as const) {
    await userEvent.keyboard(key);
    if (shows === "reply") {
      await vi.waitFor(() => {
        expect(replyView()?.checkVisibility()).toBe(true);
        expect(activeMatch("t3-sub-thread-find-active")).toBe(1);
      });
      expect(onTop(replyView()!.querySelector("[data-workspace-area='composer']")!)).toBe(true);
    } else {
      await vi.waitFor(() => {
        expect(column().inert).toBe(false);
        expect(column().dataset.chatColumnMaximizedAway).toBe("false");
        expect(activeMatch("t3-thread-find-active")).toBe(1);
      });
      expect(replyView()).toBeNull();
    }
    await expect.element(field).toBeVisible();
    expect(onTop(field.element())).toBe(true);
    expect(document.activeElement).toBe(field.element());
    expect(search()).toMatch(count);
  }
  await userEvent.keyboard("{Escape}");
  await expect.element(field).not.toBeInTheDocument();
  expect(replyView()?.checkVisibility()).toBe(true);
  expect(column().inert).toBe(true);
});

it("cites into the reply tab the user typed in, of two shown side by side", async () => {
  const { thread, firsts } = twoReplies;
  const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  const [deploy, tests] = firsts;
  const holding = (tab: TabId) =>
    paneHolding(
      resolveLayout(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
      ).root,
      tab,
    );
  using _environment = installEnvironment();
  await using _app = await openThread(thread.id, 1194);
  const replies = page.getByRole("button", { name: /1 reply/ });
  await replies.nth(0).click();
  await replies.nth(1).click();
  const testsTab = replyTabId(threadRef, tests);
  const store = useRightPanelStore.getState();
  await vi.waitFor(() => expect(holding(testsTab)).toBeDefined());
  store.updateWorkArea(threadRef, {
    type: "place",
    source: { tabs: [testsTab] },
    at: { kind: "edge", pane: holding(testsTab)!.id, edge: "bottom" },
  });
  const box = (first: string) =>
    document.querySelector<HTMLElement>(
      `[data-sub-thread-view="${first}"] [data-workspace-area="composer"] [contenteditable="true"]`,
    );
  await vi.waitFor(() => {
    expect(box(deploy)).not.toBeNull();
    expect(box(tests)).not.toBeNull();
  });
  await userEvent.click(box(tests)!);
  await userEvent.keyboard("tests note");
  const draft = (first: string) =>
    useComposerDraftStore
      .getState()
      .getComposerDraft(subThreadDraftId(scopedThreadKey(threadRef), first)!)?.prompt ?? "";
  await vi.waitFor(() => expect(draft(tests)).toContain("tests note"));

  const column = document.querySelector<HTMLElement>("[data-chat-column]")!;
  await userEvent.tripleClick(page.elementLocator(column).getByText("The deploy is done."));
  await page.getByRole("button", { name: "Cite selection in composer" }).click();

  await vi.waitFor(() =>
    expect(
      collectAssistantCitations(draft(tests)).map(({ citation }) => citation.messageId),
    ).toEqual([deploy]),
  );
  expect(collectAssistantCitations(draft(deploy))).toEqual([]);
});
