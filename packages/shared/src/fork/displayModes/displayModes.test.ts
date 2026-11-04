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
  MESSAGES_ONLY_DISPLAY_MODE,
  NORMAL_DISPLAY_MODE,
  resolveDisplayMode,
} from "./displayModes.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);

const user = (text: string): DisplayEvent => ({ type: "user", id: `user:${text}`, text });
const sent = (text: string): DisplayEvent => ({ type: "sent", id: `sent:${text}`, text });
const work: DisplayEvent = { type: "work" };
const text: DisplayEvent = { type: "text" };

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
      "the person's message",
      { type: "user_message", messageId: "m1", createdBy: "user", text: "hi" },
      { type: "user", id: "m1", text: "hi" },
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
      { type: "work" },
    ],
    [
      "a scheduled prompt",
      {
        type: "user_message",
        messageId: "m3",
        createdBy: "user",
        scheduledTaskId: "s1",
        text: "Check in",
      },
      { type: "work" },
    ],
    ["assistant text", { type: "assistant_message", text: "Working on it" }, { type: "text" }],
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
      { type: "work" },
    ],
    [
      "a send the tool refused, which ACP reports as completed with an error result",
      {
        type: "dynamic_tool",
        toolName: "t3-code.send_to_user",
        input: { text: "Done" },
        output: { content: [{ type: "text", text: "Too long" }], isError: true },
      },
      { type: "work" },
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
    ["another tool", { type: "dynamic_tool", toolName: "Read", input: {} }, { type: "work" }],
    ["a command", { type: "command_execution", input: "ls" }, { type: "work" }],
    ["a checkpoint", { type: "checkpoint" }, null],
    ["reasoning", { type: "reasoning", text: "thinking" }, null],
  ])("maps %s", (_name, fields, expected) => {
    expect(displayEventFromTurnItem(item(fields))).toEqual(expected);
  });
});

describe("visibleCores", () => {
  it("keeps the person's messages and sent messages in order", () => {
    expect(
      MESSAGES_ONLY_DISPLAY_MODE.visibleCores!([user("A"), text, work, sent("B"), text, user("C")]),
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
    expect(wrap([user("A"), work, sent("B")], "C")).toBe("C");
    expect(wrap([], "First")).toBe("First");
  });

  it("treats the person's own messages after the last sent message as a direct reply", () => {
    expect(wrap([user("A"), work, sent("B"), user("C")], "D")).toBe("D");
  });

  it("treats the agent's plain text after the last sent message as a direct reply", () => {
    expect(wrap([user("A"), work, sent("B"), text], "C")).toBe("C");
    expect(wrap([user("A"), sent("B"), text, user("C"), text], "D")).toBe("D");
  });

  it("sends the first message unchanged when the agent has only written text", () => {
    expect(wrap([user("A"), text], "B")).toBe("B");
  });

  it.each([
    ["a tool call", [work]],
    ["text, then a tool call", [text, work]],
    ["a tool call, then text", [work, text]],
    [
      "a scheduled prompt and the agent's text in a later turn",
      [
        displayEventFromTurnItem(
          item({
            type: "user_message",
            messageId: "s",
            createdBy: "user",
            scheduledTaskId: "task-1",
            text: "Daily check",
          }),
        )!,
        text,
      ],
    ],
    [
      "a bot message",
      [
        displayEventFromTurnItem(
          item({ type: "user_message", messageId: "b", createdBy: "agent", text: "From bot" }),
        )!,
      ],
    ],
  ])("wraps after %s", (_name, after) => {
    expect(wrap([user("A"), sent("B"), ...after], "C")).toBe(wrapped(["[user] A", "[you] B"], "C"));
  });

  it("lists at most 3 earlier cores in real order, two user messages in a row both counted", () => {
    expect(wrap([sent("S0"), user("A"), sent("B"), user("C"), user("D"), work], "E")).toBe(
      wrapped(["[you] B", "[user] C", "[user] D"], "E"),
    );
  });

  it("cuts each core at 2000 UTF-8 bytes on a character boundary", () => {
    const ascii = "a".repeat(2001);
    const chinese = "汉".repeat(700);
    const emoji = `${"a".repeat(1998)}🙂`;
    expect(wrap([user(ascii), user(chinese), user(emoji), work], "E")).toBe(
      wrapped(
        [
          `[user] ${"a".repeat(2000)}…[truncated]`,
          `[user] ${"汉".repeat(666)}…[truncated]`,
          `[user] ${"a".repeat(1998)}…[truncated]`,
        ],
        "E",
      ),
    );
    expect(wrap([user("a".repeat(2000)), work], "E")).toBe(
      wrapped([`[user] ${"a".repeat(2000)}`], "E"),
    );
  });

  it("uses a tag that user-view's <x-mode> pattern strips", () => {
    const text = wrap([user("A"), work], "C");
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
