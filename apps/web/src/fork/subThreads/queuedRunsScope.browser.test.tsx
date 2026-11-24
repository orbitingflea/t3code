import { CHAT_REPLIES_DISPLAY_MODE, NORMAL_DISPLAY_MODE } from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";
import { createRef, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  workflow: null as unknown,
  chat: true,
  commands: [] as unknown[],
}));

vi.mock(import("@t3tools/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../displayMode/useThreadDisplayMode"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadDisplayMode: (() =>
    state.chat ? CHAT_REPLIES_DISPLAY_MODE : NORMAL_DISPLAY_MODE) as never,
  readThreadDisplay: (() => ({
    mode: state.chat ? CHAT_REPLIES_DISPLAY_MODE : NORMAL_DISPLAY_MODE,
    dashboard: false,
  })) as never,
}));

// The main list has loaded the first messages of sub-threads A and B, not of C.
const LOADED_SUB_THREADS = vi.hoisted(
  () =>
    new Map([
      ["message:first-a", {}],
      ["message:first-b", {}],
    ]),
);
vi.mock(import("./subThreadsState"), async (importOriginal) => ({
  ...(await importOriginal()),
  useSubThreadSummaries: (() => LOADED_SUB_THREADS) as never,
  readSubThreadSummaries: (() => LOADED_SUB_THREADS) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async (input: unknown) => {
    state.commands.push(input);
    return undefined;
  }) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadShell: (() => ({ title: "Release lead" })) as never,
}));

// The queue reads the thread's projection; any loaded one will do, since the workflow is mocked.
vi.mock(import("../../state/threads"), async (importOriginal) => {
  const { createEnvironmentThreadDetailAtoms, EMPTY_ENVIRONMENT_THREAD_STATE } =
    await import("@t3tools/client-runtime/state/threads");
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const { makeThreadProjectionFixture } = await import("../../test-fixtures");
  const threadState = Atom.make(
    AsyncResult.success({
      ...EMPTY_ENVIRONMENT_THREAD_STATE,
      data: Option.some(makeThreadProjectionFixture()),
    }),
  ).pipe(Atom.keepAlive);
  return {
    ...(await importOriginal()),
    environmentThreadDetails: createEnvironmentThreadDetailAtoms(() => threadState),
  };
});

import "~/index.css";

import { render } from "../../../test/render";
import { useQueuedRunsInView } from "./queuedRunsScope";
import {
  QueuedRunsControl,
  type QueuedRunsControlHandle,
} from "../../components/chat/QueuedRunsControl";
import { SubThreadViewContext } from "./subThreadsState";

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  editBlockedReason: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
  timestampFormat: "locale",
  onOpenThread: () => undefined,
  onImageExpand: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

const replyRecord = (first: string) => ({
  version: 1,
  records: [
    { version: 1, contextId: "fork-reply", kind: "fork-reply", label: "Reply", payload: { first } },
  ],
});

const queued = (id: string, text: string, fields: Record<string, unknown>) => ({
  run: { id: `run:${id}`, userMessageId: `message:${id}` },
  text,
  attachments: [],
  ...(fields.context ? { context: fields.context } : {}),
  message: {
    id: `message:${id}`,
    role: "user",
    text,
    createdAt: DateTime.makeUnsafe("2026-11-22T12:00:00.000Z"),
    ...fields,
  },
});

const TEXTS = {
  replyA: "Typed in sub-thread A",
  main: "Typed in the main list",
  agent: "Sent by another agent",
  task: "Sent by a scheduled task",
  replyC: "Typed in sub-thread C, whose first message is not loaded",
  replyB: "Typed in sub-thread B",
} as const;

const typed = { createdBy: "user", creationSource: "web" };

function setQueue() {
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    // In queue order; each view's first and last rows differ from the thread's.
    queuedRuns: [
      queued("reply-a", TEXTS.replyA, { ...typed, context: replyRecord("message:first-a") }),
      queued("main", TEXTS.main, typed),
      queued("agent", TEXTS.agent, {
        createdBy: "agent",
        creationSource: "mcp",
        senderThreadId: "thread:lead",
      }),
      queued("task", TEXTS.task, { createdBy: "agent", scheduledTaskId: "task:nightly" }),
      queued("reply-c", TEXTS.replyC, { ...typed, context: replyRecord("message:first-c") }),
      queued("reply-b", TEXTS.replyB, { ...typed, context: replyRecord("message:first-b") }),
    ],
  };
}

async function shownTexts(
  view: string | null,
  props: Partial<ComponentProps<typeof QueuedRunsControl>> = {},
): Promise<ReadonlyArray<string>> {
  await using screen = await render(
    <SubThreadViewContext value={view}>
      <QueuedRunsControl {...baseProps} {...props} />
    </SubThreadViewContext>,
  );
  const items = screen.container.querySelectorAll("li");
  // The queue collapses past three rows; open it so every row it holds is on screen.
  const showAll = [...screen.container.querySelectorAll("button")].find((button) =>
    /^Show all/.test(button.textContent ?? ""),
  );
  if (showAll) {
    showAll.click();
    await expect
      .poll(() => screen.container.querySelectorAll("li").length)
      .toBeGreaterThan(items.length);
  }
  const text = screen.container.textContent ?? "";
  return Object.values(TEXTS).filter((candidate) => text.includes(candidate));
}

it.each([
  ["the main list", null, [TEXTS.main, TEXTS.agent, TEXTS.task, TEXTS.replyC]],
  ["sub-thread A", "message:first-a", [TEXTS.replyA]],
  ["sub-thread B", "message:first-b", [TEXTS.replyB]],
])("in Chat mode, %s shows only the queued messages that belong there", async (_, view, want) => {
  state.chat = true;
  setQueue();
  await page.viewport(1280, 800);
  expect(await shownTexts(view)).toEqual(want);
});

it("in Normal mode, the one list shows every queued message", async () => {
  state.chat = false;
  setQueue();
  expect(await shownTexts(null)).toEqual(Object.values(TEXTS));
});

it("in Chat mode, the main list's keys send and edit the main list's own queued messages", async () => {
  state.chat = true;
  state.commands = [];
  setQueue();
  const ref = createRef<QueuedRunsControlHandle>();
  const onEditQueuedRun = vi.fn();
  await using _screen = await render(
    <SubThreadViewContext value={null}>
      <QueuedRunsControl {...baseProps} ref={ref} onEditQueuedRun={onEditQueuedRun} />
    </SubThreadViewContext>,
  );
  await expect.element(page.getByText(TEXTS.main, { exact: true })).toBeVisible();
  expect(ref.current?.steerNext(false)).toBe(true);
  await expect
    .poll(() => state.commands)
    .toEqual([
      expect.objectContaining({ input: expect.objectContaining({ queuedRunId: "run:main" }) }),
    ]);
  expect(ref.current?.editLatest(false)).toBe(true);
  expect(onEditQueuedRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ runId: "run:reply-c", text: TEXTS.replyC }),
  );
});

it("in Chat mode, a queued run whose message has not arrived shows in no view", async () => {
  state.chat = true;
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    queuedRuns: [
      {
        run: { id: "run:early", userMessageId: "message:early" },
        text: "Queued message",
        attachments: [],
      },
    ],
  };
  for (const view of [null, "message:first-a"]) {
    await using screen = await render(
      <SubThreadViewContext value={view}>
        <QueuedRunsControl {...baseProps} />
      </SubThreadViewContext>,
    );
    expect(screen.container.querySelector("[data-thread-queue]")).toBeNull();
  }
});

it("keeps the queued message being edited on screen in a collapsed queue", async () => {
  state.chat = false;
  setQueue();
  await using screen = await render(
    <SubThreadViewContext value={null}>
      <QueuedRunsControl {...baseProps} editingRunId={"run:reply-b" as never} />
    </SubThreadViewContext>,
  );
  await expect.element(page.getByText(TEXTS.replyB, { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Cancel editing queued message" }))
    .toBeVisible();
  // The queue stays collapsed: its first rows, the edited row, and a truthful Show all.
  const rows = screen.container.querySelectorAll("li");
  expect(rows).toHaveLength(3);
  // The edited row keeps its place in the whole queue.
  expect(rows[2]!.getAttribute("aria-posinset")).toBe(String(Object.keys(TEXTS).length));
  const toggle = page.getByRole("button", { name: /^Show all \d+ queued$/ });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  expect(screen.container.querySelectorAll("li")).toHaveLength(Object.keys(TEXTS).length);
});

it.each([
  ["a reply in a loaded sub-thread goes to its reply box", true, "message:first-a", "sub-thread"],
  ["a reply under an unloaded first message goes to the main box", true, "message:first-c", "main"],
  ["a reply in Normal mode goes to the main box", false, "message:first-a", "main"],
])("recovered edit text: %s", async (_, chat, first, want) => {
  state.chat = chat;
  const threadRef = { environmentId: "environment:test", threadId: "thread:test" } as never;
  function Probe() {
    const target = useQueuedRunsInView(threadRef, null).recoveryTarget(replyRecord(first) as never);
    return <output>{target === threadRef ? "main" : typeof target}</output>;
  }
  await using screen = await render(<Probe />);
  expect(screen.container.textContent).toBe(want === "main" ? "main" : "string");
});

it.each([
  ["sub-thread A owns the edit of its reply", "message:first-a", "message:first-a", true],
  ["the main list does not own the edit of a reply in A", null, "message:first-a", false],
  [
    "the main list owns the edit of a reply under an unloaded first message",
    null,
    "message:first-c",
    true,
  ],
])("in Chat mode, %s, queued or not", async (_, view, first, want) => {
  state.chat = true;
  const threadRef = { environmentId: "environment:test", threadId: "thread:test" } as never;
  function Probe() {
    const owns = useQueuedRunsInView(threadRef, null).ownsEdit(replyRecord(first) as never);
    return <output>{String(owns)}</output>;
  }
  await using screen = await render(
    <SubThreadViewContext value={view}>
      <Probe />
    </SubThreadViewContext>,
  );
  expect(screen.container.textContent).toBe(String(want));
});
