import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

// A steer goes to Claude Code with no priority, so it waits in Claude's queue like text typed
// into Claude's own terminal. Claude reads it at the next tool result, or runs it as its own
// turn once the current one ends. A result whose non-empty uuid list leaves out a steer came
// before that steer ran, so the T3 turn stays open. Any other result settles the turn.
const pendingSteerUuids = new WeakMap<object, Set<string>>();

/** Records a steer sent to `turn`; the returned function forgets it, for a send that failed. */
export function trackClaudeSteer(turn: object, uuid: string): () => void {
  const pending = pendingSteerUuids.get(turn) ?? new Set<string>();
  pendingSteerUuids.set(turn, pending.add(uuid));
  return () => {
    pending.delete(uuid);
  };
}

/**
 * Whether a steer sent to `turn` is still queued after `result`. False when `result` has no
 * `user_message_uuids` or an empty list, so the turn settles on that result.
 */
export function isClaudeSteerQueuedPastResult(turn: object, result: SDKResultMessage): boolean {
  const pending = pendingSteerUuids.get(turn);
  const answered = result.user_message_uuids;
  if (pending === undefined || answered === undefined || answered.length === 0) return false;
  for (const uuid of answered) pending.delete(uuid);
  return pending.size > 0;
}
