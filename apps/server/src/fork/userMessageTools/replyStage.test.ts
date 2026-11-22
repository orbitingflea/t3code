import { MessageId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { isUnread } from "./replyStage.ts";

type UserMessage = Parameters<typeof isUnread>[0];

const stored = DateTime.makeUnsafe("2026-11-22T00:00:00.000Z");
const read = DateTime.makeUnsafe("2026-11-22T00:00:03.000Z");

const message = (id: string, fields: Partial<UserMessage> = {}): UserMessage => ({
  id: TurnItemId.make(id),
  threadId: ThreadId.make("reply-stage"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: stored,
  completedAt: stored,
  updatedAt: stored,
  type: "user_message",
  messageId: MessageId.make(id),
  inputIntent: "steer",
  text: "And the lint job?",
  attachments: [],
  createdBy: "user",
  creationSource: "web",
  ...fields,
});

describe("isUnread", () => {
  it.each<readonly [string, boolean, Partial<UserMessage>]>([
    ["a pending steer", true, { status: "pending", completedAt: null }],
    ["a cancelled steer", true, { status: "cancelled" }],
    ["a steer that no provider moved past the time it was stored", true, {}],
    ["a promoted steer that no provider moved", true, { inputIntent: "promoted_queued_to_steer" }],
    ["a steer that a provider read later", false, { completedAt: read }],
    ["a message that started a turn", false, { inputIntent: "turn_start" }],
  ])("%s is unread: %s", (_name, unread, fields) => {
    expect(isUnread(message("m", fields))).toBe(unread);
  });
});
