import { createMemoryHistory } from "@tanstack/react-router";
import { MessageId, TurnItemId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { CHAT_REPLIES_DISPLAY_MODE } from "@t3tools/shared/displayModes";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// Layout asserts need the app's styles.
import "~/index.css";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  assistantItem,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
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

/**
 * A one-turn thread whose agent also sent "The deploy is done.", which has no replies yet, or with
 * `replied`, the user's reply "Which deploy?".
 */
function threadWithAgentSend(name: string, replied = false) {
  const history = threadWithHistory(name, 1);
  const {
    messageId: _id,
    text: _text,
    streaming: _streaming,
    ...item
  } = assistantItem(history.id, history.runs[0]!.id, `${name}-news`, 2, "");
  const news = {
    ...item,
    type: "dynamic_tool" as const,
    toolName: "mcp__t3-code__send_to_user",
    input: { text: "The deploy is done.", new_sub_thread: true },
    output: { ok: true },
  };
  const reply = {
    ...item,
    id: TurnItemId.make(`${name}-reply`),
    ordinal: 3,
    type: "user_message" as const,
    messageId: MessageId.make(`${name}-reply`),
    text: "Which deploy?",
    attachments: [],
    inputIntent: "turn_start" as const,
    createdBy: "user" as const,
    creationSource: "web" as const,
    ...replyContextField(news.id),
  };
  return { ...history, items: [...history.items, news, ...(replied ? [reply] : [])] };
}

const thread = threadWithAgentSend("reply-inline");
const replied = threadWithAgentSend("reply-inline-replied", true);
const threads = [thread, replied];
const settings = {
  threadDisplayModes: Object.fromEntries(threads.map((t) => [t.id, CHAT_REPLIES_DISPLAY_MODE.id])),
};

async function openThread(threadId: string, width: number) {
  const environment = installFakeEnvironment(threads, { settings });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(width, 834);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threadId}`] }),
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

/** The agent message's Reply button, and the time in the same message row. */
async function replyAndTime() {
  const reply = page.getByRole("button", { name: "Reply", exact: true });
  await expect.element(reply).toBeInTheDocument();
  const row = reply.element().closest<HTMLElement>('[data-timeline-row-kind="message"]');
  expect(row?.dataset.messageRole).toBe("assistant");
  const time = row!.querySelector<HTMLElement>("p.tabular-nums");
  expect(time).not.toBeNull();
  return { reply: reply.element() as HTMLElement, time: time!, row: row! };
}

it.each([1194, 361])(
  "an agent message's Reply sits right of its time, on the one meta row, at %ipx",
  async (width) => {
    await using _app = await openThread(thread.id, width);
    const { reply, time, row } = await replyAndTime();

    const replyBox = reply.getBoundingClientRect();
    const timeBox = time.getBoundingClientRect();
    const middle = (box: DOMRect) => box.top + box.height / 2;
    expect(Math.abs(middle(replyBox) - middle(timeBox))).toBeLessThan(2);
    expect(replyBox.left).toBeGreaterThanOrEqual(timeBox.right);
    // Nothing of the row is drawn below the meta row.
    expect(replyBox.bottom).toBeLessThanOrEqual(row.getBoundingClientRect().bottom);
    // Reply and the time are items of the same flex row.
    expect(reply.parentElement).toBe(time.parentElement);
    expect(getComputedStyle(reply.parentElement!).display).toBe("flex");
  },
);

it("Enter on a focused Reply opens that message's replies", async () => {
  await using _app = await openThread(thread.id, 1194);
  const { reply } = await replyAndTime();
  reply.focus();
  await userEvent.keyboard("{Enter}");
  const first = thread.items.at(-1)!.id;
  await vi.waitFor(() =>
    expect(document.querySelector(`[data-sub-thread-view="${first}"]`)).not.toBeNull(),
  );
});

it("a message that has a reply shows its reply line and no Reply button", async () => {
  await using _app = await openThread(replied.id, 1194);
  await expect.element(page.getByRole("button", { name: /1 reply/ })).toBeInTheDocument();
  expect(page.getByRole("button", { name: "Reply", exact: true }).elements()).toHaveLength(0);
});
