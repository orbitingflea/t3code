import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Effect from "effect/Effect";

import { isClaudePromptUuid } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

/** A prompt uuid for a recording, so the turn's result can list the prompts it answered. */
export function claudeRecordingPromptUuid(): NonNullable<SDKUserMessage["uuid"]> {
  return Effect.runSync(
    randomUuidV4.pipe(
      Effect.filterOrDie(isClaudePromptUuid, () => new Error("Claude prompt uuid is malformed.")),
    ),
  );
}

/**
 * Reads frames up to the first turn's `system init`, so a recording steers a turn that Claude has
 * started, as T3 does; a steer sent earlier would join the first prompt.
 */
export async function recordClaudeFramesUntilInit(
  iterator: AsyncIterator<SDKMessage>,
  record: (message: SDKMessage) => void,
): Promise<void> {
  while (true) {
    const next = await iterator.next();
    if (next.done === true) {
      throw new Error("Claude active steering query ended before the turn started.");
    }
    record(next.value);
    if (next.value.type === "system" && next.value.subtype === "init") return;
  }
}
