# Fork internals

These notes document internals of changes this fork carries on top of upstream T3 Code.

## Outbox order and long timers

A thread's effects run in outbox order. A pending effect blocks every later effect of its thread,
even when its `available_at` time is hours away. Title generation has its own lane. Use a
[Scheduler](../../apps/server/src/scheduling/Scheduler.ts) sweep for a long timer, as in
[UsageLimitRecoveryWorker](../../apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts), not
a delayed outbox effect.

## Antigravity context summarization

A fixed MCP tool schema does not reach every stored Antigravity conversation. Before a turn in a
long conversation, `agy` runs context summarization with the tool declarations stored with that
conversation's last generation, not with the live MCP tool list.

Only the last `gen_metadata` row of `conversations/<id>.db` in the agent's app folder holds the full
request. When `agy` stores a new row, it shrinks the earlier rows. If that last row declares a
schema that Gemini rejects, every later turn fails with the same 400 error. `agy` logs the failure
as `pre-invocation hook: context summarization:`. Because the failed turn stores no new generation,
the conversation never recovers. A short conversation skips summarization and recovers on its next
turn.

While no turn can start on the thread, take a SQLite `.backup` of `conversations/<id>.db` and delete
that last `gen_metadata` row. Deleting that one row heals the conversation no matter how many turns
failed, and the transcript in `steps` stays.

Keep advertised schemas within what Gemini accepts, as
[the advertised schema transform](../../apps/server/src/mcp/advertisedJsonSchema.ts) does.

## The `fyi` mode of `t3_thread_send`

The `fyi` mode of `t3_thread_send` starts no turn and returns `delivery: "held"` with no run.
`t3_thread_send` rejects `fyi` with `freshContext` or with more than 16,000 characters.

When the thread starts its next turn, that turn adds the waiting FYI messages to its input. A
running Claude Code turn also receives waiting FYI messages as context after its tool calls resolve
and before its next model request.

An FYI counts as delivered only when the turn that carries it completes. A turn that fails, is
interrupted, restarts, or is rolled back gives the FYI back, so the agent may see it twice.

A thread with a waiting FYI gets a quiet wake turn after 6 idle hours. Idle time starts from the
latest of these timestamps:

- the thread's creation,
- the last activity of its runs, and
- the reset of a usage limit that failed the thread's latest run on the provider the thread still
  uses, or that limit's snooze end when later.

A wake does not happen before the thread's snooze ends. No wake reaches a thread if any of these
conditions holds:

- the thread is settled or archived,
- the thread has a run that has not ended, including a queued run,
- the thread has a runtime request that waits for an answer, or
- the thread's provider is disabled.

A wake carries waiting FYIs up to the 16,000-character turn budget. Waiting FYIs that a wake does
not carry, or gives back because the wake failed or was stopped, get another wake after 6 more idle
hours.

`t3_thread_read` marks each FYI item `fyi: "waiting"`, `"sent"`, `"delivered"`, or `"unknown"` when
its run cannot be found.
