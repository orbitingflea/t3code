import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { historicalMessage } from "@t3tools/provider-core/server/handoffBudget";
import * as DateTime from "effect/DateTime";

import { makeSideChatContext } from "../../orchestration-v2/ContextHandoffService.ts";

const threadId = ThreadId.make("thread:send-to-user-handoff");
const now = DateTime.makeUnsafe("2026-09-17T00:00:00Z");
const base = {
  id: TurnItemId.make("turn-item:send"),
  threadId,
  runId: RunId.make("run:send-to-user-handoff"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};
const send = (
  status: "completed" | "failed",
  output?: unknown,
): Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }> => ({
  ...base,
  status,
  type: "dynamic_tool",
  toolName: "mcp__t3-code__send_to_user",
  input: { text: "The fix is live." },
  ...(output === undefined ? {} : { output }),
});

it("hands over a completed send as the agent's message, and nothing else", () => {
  assert.deepInclude(historicalMessage(send("completed")), {
    role: "assistant",
    text: "The fix is live.",
    kind: "dynamic_tool",
  });
  assert.isNull(historicalMessage(send("failed")));
  assert.isNull(historicalMessage(send("completed", { isError: true, text: "refused" })));
  assert.isNull(
    historicalMessage({
      ...base,
      status: "completed",
      type: "dynamic_tool",
      toolName: "Read",
      input: { text: "not a message" },
    }),
  );
});

it("lists a send in the side chat context as the agent's message", () => {
  assert.include(
    makeSideChatContext({ parentThreadId: threadId, digest: [send("completed")] }),
    "- Assistant: The fix is live.",
  );
});
