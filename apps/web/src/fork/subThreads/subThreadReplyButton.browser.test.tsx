import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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
import { startWorkspaceFocus } from "~/lib/workspaceFocus";
import { getRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  assistantItem,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { asPaneId, replyTabId } from "../workArea/workArea.logic";
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
  useRightPanelStore.setState({ byThreadKey: {} });
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

const panes = () => [...document.querySelectorAll<HTMLElement>("[data-work-area-pane]")];
const stripOf = (pane: Element) =>
  [...pane.querySelectorAll("[data-right-panel-tab-id]")].map((tab) =>
    tab.getAttribute("data-right-panel-tab-id"),
  );
const paneHoldingTab = (tab: string) =>
  panes().find((pane) => pane.querySelector(`[data-right-panel-tab-id="${CSS.escape(tab)}"]`));

/**
 * A real native drag of `source` released at `at`, a point in viewport coordinates. Forced: the
 * Chat's column is drawn over its pane.
 */
async function dragOnto(
  source: Element,
  target: Element,
  at: (box: DOMRect) => { x: number; y: number },
) {
  const box = target.getBoundingClientRect();
  const point = at(box);
  await userEvent.dragAndDrop(page.elementLocator(source), page.elementLocator(target), {
    targetPosition: { x: point.x - box.left, y: point.y - box.top },
    steps: 12,
    force: true,
  });
}
const nearRightEdge = (box: DOMRect) => ({ x: box.right - 8, y: box.top + box.height / 2 });

const repliedFirst = replied.items.find((item) => item.type === "dynamic_tool")!.id;
const repliedTab = replyTabId(scopeThreadRef(ENVIRONMENT_ID, replied.id), repliedFirst);
const threadFirst = thread.items.at(-1)!.id;
const threadTab = replyTabId(scopeThreadRef(ENVIRONMENT_ID, thread.id), threadFirst);

it("opens a reply line dropped near the Chat pane's right edge as its reply tab in a new pane, with its box focused", async () => {
  await using _app = await openThread(replied.id, 1194);
  // The app's focus requests, which `startAppServices` starts outside AppRoot.
  using _focus = { [Symbol.dispose]: startWorkspaceFocus({ subscribe: () => () => {} } as never) };
  const line = page.getByRole("button", { name: /1 reply/ });
  await expect.element(line).toBeInTheDocument();
  expect(panes()).toHaveLength(1);

  await dragOnto(line.element(), panes()[0]!, nearRightEdge);

  await vi.waitFor(() => expect(panes()).toHaveLength(2));
  expect(stripOf(panes()[1]!)).toEqual([repliedTab]);
  expect(stripOf(panes()[0]!)).toEqual(["chat"]);
  await vi.waitFor(() =>
    expect(
      document.activeElement?.closest(
        `[data-reply-tab="${CSS.escape(repliedTab)}"] [data-workspace-area="composer"]`,
      ),
    ).not.toBeNull(),
  );
  expect(document.documentElement.hasAttribute("data-panel-link-drag")).toBe(false);
  expect(document.querySelector("[data-work-area-drop-ghost]")).toBeNull();
});

it("does not split a pane for a Reply dropped near an edge where a file tab fits but a message box does not", async () => {
  await using _app = await openThread(thread.id, 900);
  const { reply } = await replyAndTime();
  // A split there fits a 220 px tab beside the 360 px Chat, but not a second 360 px message box.
  const width = panes()[0]!.getBoundingClientRect().width;
  expect(width).toBeGreaterThan(600);
  expect(width).toBeLessThan(700);

  await dragOnto(reply, panes()[0]!, nearRightEdge);

  await vi.waitFor(() => expect(stripOf(panes()[0]!)).toEqual(["chat", threadTab]));
  expect(panes()).toHaveLength(1);
});

it("opens a Replies list row dropped on the Chat's tab as its reply tab before the Chat", async () => {
  await using _app = await openThread(replied.id, 1194);
  const repliedRef = scopeThreadRef(ENVIRONMENT_ID, replied.id);
  await expect.element(page.getByRole("button", { name: /1 reply/ })).toBeInTheDocument();
  useRightPanelStore.getState().open(repliedRef, "replies");
  const row = await vi.waitFor(() => {
    const element = document.querySelector("[data-sub-thread-list] button:not([aria-pressed])");
    expect(element).not.toBeNull();
    return element!;
  });
  const chatTab = document.querySelector('[data-right-panel-tab-id="chat"]')!;

  await dragOnto(row, chatTab, (box) => ({ x: box.left + 4, y: box.top + box.height / 2 }));

  await vi.waitFor(() => expect(stripOf(paneHoldingTab("chat")!)).toEqual([repliedTab, "chat"]));
  expect(stripOf(paneHoldingTab("replies")!)).not.toContain(repliedTab);
});

// [Chat | reply] at full width, then narrowed to the one-strip view with Chat shown: the reply's
// saved pane is not the one drawn.
async function narrowWithReplyInSecondPane(before?: () => Promise<void>) {
  const line = page.getByRole("button", { name: /1 reply/ });
  await expect.element(line).toBeInTheDocument();
  await dragOnto(line.element(), panes()[0]!, nearRightEdge);
  await vi.waitFor(() => expect(stripOf(panes()[1]!)).toEqual([repliedTab]));
  await before?.();
  await page.elementLocator(panes()[0]!.querySelector('[data-right-panel-tab-id="chat"]')!).click();
  await page.viewport(940, 834);
  await vi.waitFor(() => expect(panes()).toHaveLength(1));
  await expect.element(line).toBeVisible();
  expect(document.querySelector("[data-sub-thread-view]")).toBeNull();
  return line;
}

function watchGhost(kind: "box" | "marker") {
  let seen = false;
  const observer = new MutationObserver(() => {
    seen ||= document.querySelector(`[data-work-area-drop-ghost="${kind}"]`) !== null;
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true });
  return () => {
    observer.disconnect();
    return seen;
  };
}

it("shows a reply from another saved pane in the one-strip view's body it is dropped on", async () => {
  await using _app = await openThread(replied.id, 2000);
  const line = await narrowWithReplyInSecondPane();
  const sawBox = watchGhost("box");

  await dragOnto(line.element(), panes()[0]!, (box) => ({
    x: box.left + box.width / 2,
    y: box.top + box.height * 0.6,
  }));

  expect(sawBox()).toBe(true);
  await vi.waitFor(() => expect(document.querySelector("[data-sub-thread-view]")).not.toBeNull());
});

it("moves a reply dropped before another saved pane's first tab in the one-strip view there", async () => {
  await using _app = await openThread(replied.id, 2000);
  const repliedRef = scopeThreadRef(ENVIRONMENT_ID, replied.id);
  // [Chat reply | Files], Chat shown.
  const line = await narrowWithReplyInSecondPane(async () => {
    useRightPanelStore.getState().open(repliedRef, "files");
    await vi.waitFor(() => expect(stripOf(panes()[1]!)).toEqual([repliedTab, "files"]));
    useRightPanelStore.getState().updateWorkArea(repliedRef, {
      type: "place",
      source: { view: { pane: asPaneId(panes()[1]!.dataset.workAreaPane!), tab: repliedTab } },
      at: { kind: "join", pane: asPaneId("p0") },
    });
    await vi.waitFor(() => expect(stripOf(panes()[1]!)).toEqual(["files"]));
  });
  expect(stripOf(panes()[0]!)).toEqual(["chat", repliedTab, "files"]);
  const sawMarker = watchGhost("marker");

  await dragOnto(
    line.element(),
    document.querySelector('[data-right-panel-tab-id="files"]')!,
    (box) => ({
      x: box.left + 4,
      y: box.top + box.height / 2,
    }),
  );

  expect(sawMarker()).toBe(true);
  await page.viewport(2000, 834);
  await vi.waitFor(() => expect(panes()).toHaveLength(2));
  expect(stripOf(panes()[0]!)).toEqual(["chat"]);
  expect(stripOf(panes()[1]!)).toEqual([repliedTab, "files"]);
});
