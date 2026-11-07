import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { historicalMessage } from "@t3tools/provider-core/server/handoffBudget";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ContextHandoffService from "../../orchestration-v2/ContextHandoffService.ts";
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

const rewrite: OrchestrationV2TurnItem = {
  ...base,
  id: TurnItemId.make("turn-item:rewrite"),
  ordinal: 2,
  status: "completed",
  type: "dynamic_tool",
  toolName: "mcp__t3-code__replace_send_to_user",
  input: {
    user_message: "Is it live?",
    old_text: "The fix is live.",
    new_text: "The fix is live and verified.",
  },
};
const rewritten = [send("completed"), rewrite];

it("lists a rewritten send once, with its new text, in the side chat context", () => {
  const context = makeSideChatContext({ parentThreadId: threadId, digest: rewritten });
  assert.include(context, "- Assistant: The fix is live and verified.");
  assert.notInclude(context, "- Assistant: The fix is live.\n");
  assert.strictEqual(context.split("- Assistant:").length, 2);
});

it.effect("hands over a rewritten send once, with its new text", () =>
  Effect.gen(function* () {
    const service = yield* ContextHandoffService.ContextHandoffServiceV2;
    const handover = {
      threadId,
      targetRunId: RunId.make("run:send-to-user-handoff:next"),
      transferId: null,
      fromProviderThreadIds: [ProviderThreadId.make("provider-thread:from")],
      toProviderThreadId: ProviderThreadId.make("provider-thread:to"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
      coveredRunOrdinals: { from: 1, to: 1 },
      createdAt: now,
    };
    const provider = yield* service.prepareProviderHandoff({
      ...handover,
      strategy: "full_thread_summary",
      items: rewritten,
    });
    assert.deepEqual(
      provider.history?.messages.map(({ itemId, text }) => ({ itemId, text })),
      [{ itemId: base.id, text: "The fix is live and verified." }],
    );
    const fork = yield* service.prepareForkDelta({
      ...handover,
      sourceThreadId: threadId,
      targetThreadId: ThreadId.make("thread:send-to-user-handoff:fork"),
      deltaItems: rewritten,
    });
    assert.deepEqual(
      fork.history?.messages.map(({ text }) => text),
      ["The fix is live and verified."],
    );
    assert.include(fork.summaryText ?? "", "- Assistant: The fix is live and verified.");
    assert.strictEqual((fork.summaryText ?? "").split("- Assistant:").length, 2);
    // A delta that starts after the send still carries its rewrite.
    const later = yield* service.prepareForkDelta({
      ...handover,
      sourceThreadId: threadId,
      targetThreadId: ThreadId.make("thread:send-to-user-handoff:later"),
      deltaItems: [rewrite],
    });
    assert.deepEqual(
      later.history?.messages.map(({ text }) => text),
      ["The fix is live and verified."],
    );
    assert.include(later.summaryText ?? "", "- Assistant: The fix is live and verified.");
  }).pipe(Effect.provide(ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)))),
);
