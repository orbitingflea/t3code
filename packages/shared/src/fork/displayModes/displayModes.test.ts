import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationV2TurnItem,
  ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { applyServerSettingsPatch } from "../../serverSettings.ts";

import {
  type DisplayEvent,
  displayEventFromTurnItem,
  displayModeShowsText,
  isWebTypedMessage,
  MESSAGES_ONLY_DISPLAY_MODE,
  NORMAL_DISPLAY_MODE,
  resolveDisplayMode,
  sentMessageText,
} from "./displayModes.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);

const user = (text: string): DisplayEvent => ({ type: "user", id: `user:${text}`, text });
const sent = (text: string): DisplayEvent => ({ type: "sent", id: `sent:${text}`, text });
const other: DisplayEvent = { type: "other" };

const wrap = (events: ReadonlyArray<DisplayEvent>, text: string) =>
  MESSAGES_ONLY_DISPLAY_MODE.wrap!(events, text);

const wrapped = (lines: ReadonlyArray<string>, text: string) =>
  [
    "<t3-messages-mode>",
    "This message is from the user. Other things happened in this thread since your last message to them, or since the thread began if you sent none. The user's screen showed:",
    ...lines,
    "</t3-messages-mode>",
    text,
  ].join("\n");

const item = (fields: Record<string, unknown>) =>
  ({
    id: "item-1",
    status: "completed",
    ...fields,
  }) as unknown as OrchestrationV2TurnItem;

describe("displayEventFromTurnItem", () => {
  it.each([
    [
      "the user's message",
      {
        type: "user_message",
        messageId: "m1",
        createdBy: "user",
        creationSource: "web",
        text: "hi",
      },
      { type: "user", id: "m1", text: "hi" },
    ],
    [
      "the user's message from the mobile app",
      {
        type: "user_message",
        messageId: "m1",
        createdBy: "user",
        creationSource: "mobile",
        text: "hi",
      },
      { type: "user", id: "m1", text: "hi" },
    ],
    [
      "an automatic retry after a usage limit",
      {
        type: "user_message",
        messageId: "m4",
        createdBy: "user",
        creationSource: "server",
        text: "Continue where you left off.",
      },
      { type: "other" },
    ],
    [
      "a user message that the provider made",
      {
        type: "user_message",
        messageId: "m5",
        createdBy: "user",
        creationSource: "provider",
        text: "Background task finished",
      },
      { type: "other" },
    ],
    [
      "T3 Code's own /compact when the user returns",
      {
        type: "user_message",
        messageId: "m6",
        createdBy: "user",
        creationSource: "web",
        idleCompaction: "onReturn",
        text: "/compact",
      },
      { type: "other" },
    ],
    [
      "a bot's message",
      {
        type: "user_message",
        messageId: "m2",
        createdBy: "agent",
        senderThreadId: "t2",
        text: "From bot",
      },
      { type: "other" },
    ],
    [
      "a scheduled prompt",
      {
        type: "user_message",
        messageId: "m3",
        createdBy: "user",
        creationSource: "web",
        scheduledTaskId: "s1",
        text: "Check in",
      },
      { type: "other" },
    ],
    ["assistant text", { type: "assistant_message", text: "Working on it" }, { type: "other" }],
    ["blank assistant text", { type: "assistant_message", text: "  " }, null],
    [
      "a completed send",
      { type: "dynamic_tool", toolName: "mcp__t3-code__send_to_user", input: { text: "Done" } },
      { type: "sent", id: "item-1", text: "Done" },
    ],
    [
      "a failed send",
      {
        type: "dynamic_tool",
        status: "failed",
        toolName: "mcp__t3-code__send_to_user",
        input: { text: "Done" },
      },
      { type: "other" },
    ],
    [
      "a send the tool refused, which ACP reports as completed with an error result",
      {
        type: "dynamic_tool",
        toolName: "t3-code.send_to_user",
        input: { text: "Done" },
        output: { content: [{ type: "text", text: "Too long" }], isError: true },
      },
      { type: "other" },
    ],
    [
      "a running send",
      {
        type: "dynamic_tool",
        status: "running",
        toolName: "t3-code.send_to_user",
        input: { text: "Done" },
      },
      null,
    ],
    [
      "a queued message that has not started",
      {
        type: "user_message",
        messageId: "m1",
        createdBy: "user",
        creationSource: "web",
        text: "next",
        inputIntent: "queued_turn",
        status: "pending",
      },
      null,
    ],
    [
      "a queued message that has started",
      {
        type: "user_message",
        messageId: "m1",
        createdBy: "user",
        creationSource: "web",
        text: "next",
        inputIntent: "queued_turn",
      },
      { type: "user", id: "m1", text: "next" },
    ],
    ["another tool", { type: "dynamic_tool", toolName: "Read", input: {} }, { type: "other" }],
    ["a command", { type: "command_execution", input: "ls" }, { type: "other" }],
    ["a checkpoint", { type: "checkpoint" }, null],
    ["reasoning", { type: "reasoning", text: "thinking" }, { type: "other" }],
  ])("maps %s", (_name, fields, expected) => {
    expect(displayEventFromTurnItem(item(fields))).toEqual(expected);
  });
});

describe("visibleCores", () => {
  it("keeps the user's messages and sent messages in order", () => {
    expect(
      MESSAGES_ONLY_DISPLAY_MODE.visibleCores!([user("A"), other, sent("B"), other, user("C")]),
    ).toEqual([
      { id: "user:A", from: "user", text: "A" },
      { id: "sent:B", from: "agent", text: "B" },
      { id: "user:C", from: "user", text: "C" },
    ]);
  });

  it("is null for Normal, which shows everything", () => {
    expect(NORMAL_DISPLAY_MODE.visibleCores).toBeNull();
    expect(NORMAL_DISPLAY_MODE.wrap).toBeNull();
  });
});

describe("Messages only wrap", () => {
  it("sends a direct reply unchanged", () => {
    expect(wrap([user("A"), other, sent("B")], "C")).toBe("C");
    expect(wrap([], "First")).toBe("First");
  });

  it("treats the user's own messages after the last sent message as a direct reply", () => {
    expect(wrap([user("A"), other, sent("B"), user("C")], "D")).toBe("D");
  });

  const fromItem = (fields: Record<string, unknown>) => displayEventFromTurnItem(item(fields))!;

  it.each([
    ["a tool call", [fromItem({ type: "command_execution", input: "ls" })]],
    ["the agent's plain text", [fromItem({ type: "assistant_message", text: "Done" })]],
    ["reasoning", [fromItem({ type: "reasoning", text: "thinking" })]],
    [
      "a scheduled prompt and the agent's text in a later turn",
      [
        fromItem({
          type: "user_message",
          messageId: "s",
          createdBy: "user",
          scheduledTaskId: "task-1",
          text: "Daily check",
        }),
        fromItem({ type: "assistant_message", text: "Checked" }),
      ],
    ],
    [
      "a bot message",
      [fromItem({ type: "user_message", messageId: "b", createdBy: "agent", text: "From bot" })],
    ],
    [
      "an automatic retry after a usage limit",
      [
        fromItem({
          type: "user_message",
          messageId: "r",
          createdBy: "user",
          creationSource: "server",
          text: "Continue where you left off.",
        }),
      ],
    ],
  ])("wraps after %s", (_name, after) => {
    expect(wrap([user("A"), sent("B"), ...after], "C")).toBe(wrapped(["[user] A", "[you] B"], "C"));
  });

  it("wraps when the agent wrote text between the user's messages", () => {
    const reply = fromItem({ type: "assistant_message", text: "Noted" });
    expect(wrap([user("A"), sent("B"), user("C"), reply, user("D")], "E")).toBe(
      wrapped(["[you] B", "[user] C", "[user] D"], "E"),
    );
  });

  it("wraps the first message when the agent has only written text", () => {
    expect(wrap([user("A"), other], "B")).toBe(wrapped(["[user] A"], "B"));
  });

  it("lists at most 3 earlier cores in real order, two user messages in a row both counted", () => {
    expect(wrap([sent("S0"), user("A"), sent("B"), user("C"), user("D"), other], "E")).toBe(
      wrapped(["[you] B", "[user] C", "[user] D"], "E"),
    );
  });

  it("cuts each core at 2000 UTF-8 bytes on a character boundary", () => {
    const ascii = "a".repeat(2001);
    const chinese = "汉".repeat(700);
    const emoji = `${"a".repeat(1998)}🙂`;
    expect(wrap([user(ascii), user(chinese), user(emoji), other], "E")).toBe(
      wrapped(
        [
          `[user] ${"a".repeat(2000)}…[truncated]`,
          `[user] ${"汉".repeat(666)}…[truncated]`,
          `[user] ${"a".repeat(1998)}…[truncated]`,
        ],
        "E",
      ),
    );
    expect(wrap([user("a".repeat(2000)), other], "E")).toBe(
      wrapped([`[user] ${"a".repeat(2000)}`], "E"),
    );
  });

  it("uses a tag that user-view's <x-mode> pattern strips", () => {
    const text = wrap([user("A"), other], "C");
    // user-view is an outside tool that shows a transcript as the user saw it.
    // It removes the blocks that match this pattern, and then it trims the whitespace around them.
    expect(text.replace(/<([a-z][a-z0-9_-]*-mode)>[\s\S]*?<\/\1>/g, "").trim()).toBe("C");
  });
});

describe("resolveDisplayMode", () => {
  it("falls back to Normal for a missing or unknown id", () => {
    expect(resolveDisplayMode(undefined)).toBe(NORMAL_DISPLAY_MODE);
    expect(resolveDisplayMode("retired-experiment")).toBe(NORMAL_DISPLAY_MODE);
    expect(resolveDisplayMode("messages-only")).toBe(MESSAGES_ONLY_DISPLAY_MODE);
  });
});

describe("threadDisplayModes setting", () => {
  it("sets and clears one thread without touching the others", () => {
    const set = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      threadDisplayModes: { "thread-a": "messages-only", "thread-b": "messages-only" },
    });
    const cleared = applyServerSettingsPatch(set, { threadDisplayModes: { "thread-a": null } });
    expect(cleared.threadDisplayModes).toEqual({ "thread-b": "messages-only" });
  });

  it("decodes settings written before the setting existed", () => {
    expect(decodeServerSettings({}).threadDisplayModes).toEqual({});
  });
});

describe("isWebTypedMessage", () => {
  it.each([
    ["web", true],
    ["mobile", false],
    ["server", false],
  ] as const)("returns the right answer for a user's message from %s", (creationSource, web) => {
    expect(isWebTypedMessage({ createdBy: "user", creationSource })).toBe(web);
  });

  it("returns false for a scheduled message from the web app", () => {
    expect(
      isWebTypedMessage({ createdBy: "user", creationSource: "web", scheduledTaskId: "task" }),
    ).toBe(false);
  });
});

describe("displayModeShowsText", () => {
  const send = (status: string) =>
    item({
      type: "dynamic_tool",
      toolName: "mcp__t3-code__send_to_user",
      input: { text: "hi" },
      status,
    });
  const assistant = item({ type: "assistant_message", messageId: "m2", text: "hi" });
  const typed = item({
    type: "user_message",
    messageId: "m1",
    createdBy: "user",
    creationSource: "web",
    text: "hi",
  });
  const tool = item({ type: "dynamic_tool", toolName: "Read", input: {} });

  it.each([
    ["normal", typed, true],
    ["normal", assistant, true],
    ["normal", send("completed"), true],
    ["normal", send("failed"), false],
    ["normal", send("running"), false],
    ["normal", tool, false],
    ["messages-only", typed, true],
    ["messages-only", assistant, false],
    ["messages-only", send("completed"), true],
    ["messages-only", send("failed"), false],
    ["messages-only", tool, false],
  ])("for mode %s and item %#", (modeId, turnItem, shown) => {
    expect(displayModeShowsText(modeId, turnItem)).toBe(shown);
  });
});

describe("sentMessageText", () => {
  it("returns the text of a completed send only", () => {
    const send = {
      type: "dynamic_tool",
      toolName: "mcp__t3-code__send_to_user",
      input: { text: "hi" },
    };
    expect(sentMessageText(item(send))).toBe("hi");
    expect(sentMessageText(item({ ...send, status: "failed" }))).toBeNull();
    expect(sentMessageText(item({ type: "command_execution", input: "ls" }))).toBeNull();
  });
});
