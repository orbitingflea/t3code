import { createMemoryHistory } from "@tanstack/react-router";
import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { CHAT_REPLIES_DISPLAY_MODE } from "@t3tools/shared/displayModes";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/index.css";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  assistantItem,
  emitThreadEvent,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { replyContextField } from "./subThreadReply";

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

const QUEUED_MAIN = "Queued in the main list";
const QUEUED_AGENT = "Queued by another agent";
const QUEUED_REPLY = "Queued in the deploy's replies";
const AT = DateTime.makeUnsafe("2026-11-23T00:00:00.000Z");

/**
 * A one-turn thread whose agent sent "The deploy is done.", with three queued messages: one typed in
 * the main list, one from another agent, and one typed in the deploy message's replies.
 */
function threadWithQueue(): FakeThread {
  const history = threadWithHistory("queued-scope", 1);
  const {
    messageId: _id,
    text: _text,
    streaming: _streaming,
    ...item
  } = assistantItem(history.id, history.runs[0]!.id, "queued-scope-news", 2, "");
  const news = {
    ...item,
    type: "dynamic_tool" as const,
    toolName: "mcp__t3-code__send_to_user",
    input: { text: "The deploy is done.", new_sub_thread: true },
    output: { ok: true },
  };
  const queued = [
    { id: "main", text: QUEUED_MAIN, fields: { createdBy: "user", creationSource: "web" } },
    {
      id: "agent",
      text: QUEUED_AGENT,
      fields: {
        createdBy: "agent",
        creationSource: "mcp",
        senderThreadId: ThreadId.make("lead"),
      },
    },
    {
      id: "reply",
      text: QUEUED_REPLY,
      fields: { createdBy: "user", creationSource: "web", ...replyContextField(news.id) },
    },
  ] as const;
  return {
    ...history,
    items: [...history.items, news],
    runs: [
      ...history.runs,
      ...queued.map(({ id }, index) => ({
        ...history.runs[0]!,
        id: RunId.make(`queued-${id}`),
        ordinal: index + 2,
        userMessageId: MessageId.make(`queued-${id}-message`),
        status: "queued" as const,
        startedAt: null,
        completedAt: null,
      })),
    ],
    messages: queued.map(({ id, text, fields }) => ({
      id: MessageId.make(`queued-${id}-message`),
      threadId: history.id,
      runId: RunId.make(`queued-${id}`),
      nodeId: null,
      role: "user" as const,
      text,
      attachments: [],
      streaming: false,
      createdAt: AT,
      updatedAt: AT,
      ...fields,
    })) as never,
  };
}

async function openChatThread(thread: FakeThread) {
  const environment = installFakeEnvironment([thread], {
    settings: { threadDisplayModes: { [thread.id]: CHAT_REPLIES_DISPLAY_MODE.id } },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1194, 834);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  try {
    await router.load();
    const app = await render(<AppRoot router={router} />, { router: false });
    return {
      [Symbol.asyncDispose]: async () => {
        await app[Symbol.asyncDispose]();
        environment[Symbol.dispose]();
      },
    };
  } catch (error) {
    environment[Symbol.dispose]();
    throw error;
  }
}

/** The queued texts that the queue of the view `root` lists. */
const queuedIn = (root: Element) =>
  [QUEUED_MAIN, QUEUED_AGENT, QUEUED_REPLY].filter((text) =>
    root.querySelector("[data-thread-queue]")?.textContent?.includes(text),
  );

it("in Chat mode, each view lists only its own queued messages", async () => {
  const thread = threadWithQueue();
  await using _app = await openChatThread(thread);
  await expect.element(page.getByText(QUEUED_MAIN, { exact: true })).toBeVisible();
  // Only the main list is open, so the page holds one queue.
  expect(queuedIn(document.body)).toEqual([QUEUED_MAIN, QUEUED_AGENT]);

  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const news = thread.items.at(-1)!.id;
  await expect
    .poll(() => document.querySelector(`[data-sub-thread-view="${news}"]`))
    .not.toBeNull();
  const replies = document.querySelector(`[data-sub-thread-view="${news}"]`)!;
  await expect.poll(() => queuedIn(replies)).toEqual([QUEUED_REPLY]);
  // The main list still lists its own two, and not the reply.
  const mainQueue = [...document.querySelectorAll("[data-thread-queue]")].find(
    (queue) => !replies.contains(queue),
  )!;
  expect(queuedIn(mainQueue.parentElement!)).toEqual([QUEUED_MAIN, QUEUED_AGENT]);
});

it("in Chat mode, a queued reply never shows in the main list while its message is on the way", async () => {
  const full = threadWithQueue();
  const runOf = (id: string) => full.runs.find((candidate) => candidate.id === id)!;
  const messageOf = (id: string) =>
    full.messages!.find((candidate) => candidate.id === runOf(id).userMessageId)!;
  const thread = { ...full, runs: full.runs.slice(0, 1), messages: [] };
  await using _app = await openChatThread(thread);
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const news = thread.items.at(-1)!.id;
  await expect
    .poll(() => document.querySelector(`[data-sub-thread-view="${news}"]`))
    .not.toBeNull();
  const replies = document.querySelector(`[data-sub-thread-view="${news}"]`)!;
  const mainQueueText = () =>
    [...document.querySelectorAll("[data-thread-queue]")]
      .filter((queue) => !replies.contains(queue))
      .map((queue) => queue.textContent ?? "")
      .join("");

  // The server announces the reply's run before its message. A main-list message, queued after it
  // with its message, marks the moment the main list has seen the reply's run.
  await emitThreadEvent(thread.id, { type: "run.created", payload: runOf("queued-reply") });
  await emitThreadEvent(thread.id, { type: "message.updated", payload: messageOf("queued-main") });
  await emitThreadEvent(thread.id, { type: "run.created", payload: runOf("queued-main") });
  await expect.poll(mainQueueText).toContain(QUEUED_MAIN);
  expect(mainQueueText()).not.toContain("Queued message");
  expect(queuedIn(replies)).toEqual([]);

  await emitThreadEvent(thread.id, { type: "message.updated", payload: messageOf("queued-reply") });
  await expect.poll(() => queuedIn(replies)).toEqual([QUEUED_REPLY]);
  expect(mainQueueText()).not.toContain(QUEUED_REPLY);
});

it("in Chat mode, a reply's queue offers no keyboard shortcut, since its keys do not run there", async () => {
  const thread = threadWithQueue();
  await using _app = await openChatThread(thread);
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const news = thread.items.at(-1)!.id;
  await expect
    .poll(() => document.querySelector(`[data-sub-thread-view="${news}"] [data-thread-queue]`))
    .not.toBeNull();
  const replyQueue = document.querySelector(
    `[data-sub-thread-view="${news}"] [data-thread-queue]`,
  )!;
  await page.elementLocator(replyQueue).getByRole("button", { name: "Send now" }).hover();
  await expect.element(page.getByText(/^Start a turn with this message/)).toBeVisible();
  expect(page.getByText(/^Start a turn with this message/).element().textContent).toBe(
    "Start a turn with this message",
  );
});

it("in Chat mode, a queued reply is edited in its own reply box", async () => {
  const thread = threadWithQueue();
  await using _app = await openChatThread(thread);
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  const news = thread.items.at(-1)!.id;
  await expect
    .poll(() => document.querySelector(`[data-sub-thread-view="${news}"] [data-thread-queue]`))
    .not.toBeNull();
  const replies = document.querySelector(`[data-sub-thread-view="${news}"]`)!;
  await page
    .elementLocator(replies.querySelector("[data-thread-queue]")!)
    .getByRole("button", { name: "Edit queued message" })
    .click();

  await expect
    .poll(() => replies.querySelector("[data-thread-queue]")?.textContent)
    .toContain("Editing in the composer");
  const editors = [...document.querySelectorAll('[data-testid="composer-editor"]')];
  const replyEditor = editors.find((editor) => replies.contains(editor))!;
  const mainEditor = editors.find((editor) => !replies.contains(editor))!;
  await expect.poll(() => replyEditor.textContent).toContain(QUEUED_REPLY);
  expect(mainEditor.textContent).not.toContain(QUEUED_REPLY);
  const mainQueue = [...document.querySelectorAll("[data-thread-queue]")].find(
    (queue) => !replies.contains(queue),
  )!;
  expect(mainQueue.textContent).not.toContain("Editing in the composer");
});
