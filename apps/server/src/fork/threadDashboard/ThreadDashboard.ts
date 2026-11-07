import {
  DASHBOARD_SLOT_IDS,
  DashboardSlotId,
  type ThreadDashboard as ThreadDashboardSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { TEXT_MATCH_MIN_RATIO, textSimilarity } from "@t3tools/shared/textMatch";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

export interface ThreadDashboardShape {
  readonly read: (threadId: ThreadId) => Effect.Effect<ThreadDashboardSnapshot>;
  /**
   * Replaces the slot's text with `newText` when `oldText` is close enough to its current text, so
   * a writer working from a stale copy cannot drop what changed since. Empty text clears the slot.
   */
  readonly set: (
    threadId: ThreadId,
    slot: DashboardSlotId,
    oldText: string,
    newText: string,
  ) => Effect.Effect<ThreadDashboardSnapshot, DashboardTextMismatch>;
  /** Records `text` as read, unless the slot has changed since the user read it. */
  readonly markSeen: (input: {
    readonly threadId: ThreadId;
    readonly slot: DashboardSlotId;
    readonly text: string;
  }) => Effect.Effect<void>;
  /** The current snapshot, then each later one. */
  readonly changes: (threadId: ThreadId) => Stream.Stream<ThreadDashboardSnapshot>;
}

export class DashboardTextMismatch extends Schema.TaggedError<DashboardTextMismatch>()(
  "DashboardTextMismatch",
  { slot: DashboardSlotId, current: Schema.String, similarity: Schema.Number },
) {}

export class ThreadDashboard extends Context.Service<ThreadDashboard, ThreadDashboardShape>()(
  "t3/fork/threadDashboard/ThreadDashboard",
) {}

interface SlotRow {
  readonly slot: string;
  readonly text: string;
  readonly updated_at: string;
  readonly seen_text: string | null;
}

/** Removes the Dashboard of each deleted thread. A deleted thread keeps its projection row. */
const pruneDeletedThreadDashboards = Effect.fn("ThreadDashboard.pruneDeletedThreadDashboards")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM fork_thread_dashboard WHERE thread_id IN (
    SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
  )`;
  },
);

export const layer: Layer.Layer<ThreadDashboard, never, SqlClient.SqlClient> = Layer.effect(
  ThreadDashboard,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Rows outlive the thread's display mode, so switching back shows the same Dashboard.
    yield* sql`CREATE TABLE IF NOT EXISTS fork_thread_dashboard (
      thread_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      seen_text TEXT,
      PRIMARY KEY (thread_id, slot)
    )`.pipe(Effect.orDie);
    yield* pruneDeletedThreadDashboards().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Dashboard prune skipped", { cause })),
    );

    const load = (threadId: ThreadId) =>
      sql<SlotRow>`
        SELECT slot, text, updated_at, seen_text FROM fork_thread_dashboard
        WHERE thread_id = ${threadId}
      `.pipe(
        Effect.orDie,
        Effect.map((rows): ThreadDashboardSnapshot => {
          const bySlot = new Map(rows.map((row) => [row.slot, row]));
          return {
            threadId,
            slots: DASHBOARD_SLOT_IDS.map((slot) => {
              const row = bySlot.get(slot);
              return {
                slot,
                text: row?.text ?? "",
                updatedAt: row?.updated_at ?? null,
                seenText: row?.seen_text ?? null,
              };
            }),
          };
        }),
      );

    // One ref per thread in use. Every write goes through the ref, which serializes the thread's
    // writes and publishes each snapshot in order; an unused ref is dropped and reloads from the table.
    const refs = yield* RcMap.make({
      lookup: (threadId: ThreadId) => load(threadId).pipe(Effect.flatMap(SubscriptionRef.make)),
    });
    const modify = <A, E>(
      threadId: ThreadId,
      f: (
        snapshot: ThreadDashboardSnapshot,
      ) => Effect.Effect<readonly [A, ThreadDashboardSnapshot], E>,
    ) =>
      RcMap.get(refs, threadId).pipe(
        Effect.flatMap((ref) => SubscriptionRef.modifyEffect(ref, f)),
        Effect.scoped,
      );
    const withSlot = (
      snapshot: ThreadDashboardSnapshot,
      slot: DashboardSlotId,
      fields: Partial<ThreadDashboardSnapshot["slots"][number]>,
    ): ThreadDashboardSnapshot => ({
      ...snapshot,
      slots: snapshot.slots.map((entry) => (entry.slot === slot ? { ...entry, ...fields } : entry)),
    });

    const read: ThreadDashboardShape["read"] = (threadId) =>
      RcMap.get(refs, threadId).pipe(Effect.flatMap(SubscriptionRef.get), Effect.scoped);

    const set: ThreadDashboardShape["set"] = Effect.fn("ThreadDashboard.set")(function* (
      threadId: ThreadId,
      slot: DashboardSlotId,
      oldText: string,
      text: string,
    ) {
      return yield* modify(threadId, (snapshot) =>
        Effect.gen(function* () {
          const current = snapshot.slots.find((entry) => entry.slot === slot)?.text ?? "";
          const similarity = textSimilarity(current, oldText);
          if (similarity < TEXT_MATCH_MIN_RATIO) {
            return yield* new DashboardTextMismatch({ slot, current, similarity });
          }
          const updatedAt = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
              INSERT INTO fork_thread_dashboard (thread_id, slot, text, updated_at, seen_text)
              VALUES (${threadId}, ${slot}, ${text}, ${updatedAt}, NULL)
              ON CONFLICT (thread_id, slot)
              DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
            `.pipe(Effect.orDie);
          const next = withSlot(snapshot, slot, { text, updatedAt });
          return [next, next] as const;
        }),
      );
    });

    const markSeen: ThreadDashboardShape["markSeen"] = Effect.fn("ThreadDashboard.markSeen")(
      function* ({ threadId, slot, text }: Parameters<ThreadDashboardShape["markSeen"]>[0]) {
        yield* modify(threadId, (snapshot) =>
          Effect.gen(function* () {
            const current = snapshot.slots.find((entry) => entry.slot === slot);
            if (
              current === undefined ||
              current.updatedAt === null ||
              current.text !== text ||
              current.seenText === text
            ) {
              return [undefined, snapshot] as const;
            }
            yield* sql`
              UPDATE fork_thread_dashboard SET seen_text = ${text}
              WHERE thread_id = ${threadId} AND slot = ${slot} AND text = ${text}
            `.pipe(Effect.orDie);
            return [undefined, withSlot(snapshot, slot, { seenText: text })] as const;
          }),
        );
      },
    );

    const changes: ThreadDashboardShape["changes"] = (threadId) =>
      Stream.unwrap(RcMap.get(refs, threadId).pipe(Effect.map(SubscriptionRef.changes)));

    return ThreadDashboard.of({ read, set, markSeen, changes });
  }),
);
