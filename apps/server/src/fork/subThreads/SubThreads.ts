import type { ThreadId, ThreadSubThread, ThreadSubThreads } from "@t3tools/contracts";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import {
  SUB_THREAD_RECORD_KIND,
  subThreadRecap,
  type VisibleCore,
} from "@t3tools/shared/displayModes";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RcMap from "effect/RcMap";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { userTypedSql } from "../shownHistory/ShownHistory.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { SUMMARY_INSTRUCTIONS } from "./summaryInstructions.ts";

export interface SubThreadsShape {
  /** The current snapshot, then each later one. */
  readonly changes: (threadId: ThreadId) => Stream.Stream<ThreadSubThreads>;
  /** Keeps the later of the stored and the given time. */
  readonly markRead: (input: {
    readonly threadId: ThreadId;
    readonly firstId: string;
    readonly readAt: string;
  }) => Effect.Effect<void>;
  /**
   * Call when what the user sees in Chat-mode sub-thread `firstId` changes. It returns at once and
   * never fails. It makes a summary label in the background at 1, 3, 6, or 10 user messages shown
   * in Chat, then every 10 after the last label. `thread` holds the latest messages, oldest first,
   * and may be stale. A call acts only if `thread` ends with a user message or no label exists yet.
   */
  readonly changed: (input: {
    readonly threadId: ThreadId;
    readonly firstId: string;
    readonly thread: ReadonlyArray<VisibleCore>;
  }) => Effect.Effect<void>;
}

export class SubThreads extends Context.Service<SubThreads, SubThreadsShape>()(
  "t3/fork/subThreads/SubThreads",
) {}

const SUMMARY_MAX_CHARACTERS = 80;
const SUMMARY_FIRST_COUNTS = [1, 3, 6, 10];
const SUMMARY_COUNT_STEP = 10;

/** The latest count at most `userMessages` that makes a summary, or 0. */
const latestSummaryCount = (userMessages: number) =>
  Math.max(
    SUMMARY_FIRST_COUNTS.findLast((count) => count <= userMessages) ?? 0,
    userMessages - (userMessages % SUMMARY_COUNT_STEP),
  );

/**
 * A call for the sub-thread's latest user message in `thread`. Only the wrap of a user reply ends
 * with it; any other call acts only while the sub-thread has no label, as when an agent's answer
 * opens a sub-thread under the user's message.
 */
interface Wrap {
  readonly thread: ReadonlyArray<VisibleCore>;
  readonly messageId: string;
  readonly wrapsIt: boolean;
}

/** Logs the failure and gives `fallback`. An interruption stays one. */
const logFailure =
  <A>(message: string, fields: Record<string, unknown>, fallback: A) =>
  (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause }).pipe(Effect.as(fallback));

const cutSummary = (text: string) =>
  Array.from(text.trim().replace(/\s+/g, " ")).slice(0, SUMMARY_MAX_CHARACTERS).join("");

/**
 * The first message and the latest ones, in the form that the thread title model gets for a
 * thread: sections by role. The title prompt and its evals are written for this form.
 */
const summaryInput = (thread: ReadonlyArray<VisibleCore>) =>
  formatThreadTitleContext(
    subThreadRecap(thread).map((core) => ({
      role: core.from === "user" ? ("user" as const) : ("assistant" as const),
      text: core.text,
    })),
  ).message;

const isLater = (time: string, stored: string | null) =>
  Date.parse(time) > (stored === null ? Number.NEGATIVE_INFINITY : Date.parse(stored));

const withSubThread = (
  snapshot: ThreadSubThreads,
  firstId: string,
  fields: Partial<Omit<ThreadSubThread, "firstId">>,
): ThreadSubThreads => ({
  ...snapshot,
  subThreads: snapshot.subThreads.some((entry) => entry.firstId === firstId)
    ? snapshot.subThreads.map((entry) =>
        entry.firstId === firstId ? { ...entry, ...fields } : entry,
      )
    : [...snapshot.subThreads, { firstId, readAt: null, summary: null, ...fields }],
});

interface SubThreadRow {
  readonly first_id: string;
  readonly read_at: string | null;
  readonly summary: string | null;
}

/** Removes the rows of each deleted thread. A deleted thread keeps its projection row. */
const pruneDeletedThreads = Effect.fn("SubThreads.pruneDeletedThreads")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const deleted = sql`
    SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
  `;
  yield* sql`DELETE FROM fork_thread_sub_thread WHERE thread_id IN (${deleted})`;
  yield* sql`DELETE FROM fork_thread_sub_thread_covered WHERE thread_id IN (${deleted})`;
  yield* sql`DELETE FROM fork_thread_sub_thread_tried WHERE thread_id IN (${deleted})`;
});

/** The service over the stores and the text generation that the caller provides. */
export const layerFromServices = Layer.effect(
  SubThreads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const textGeneration = yield* TextGeneration.TextGeneration;
    const fileSystem = yield* FileSystem.FileSystem;
    const layerScope = yield* Effect.scope;

    // Rows outlive the thread's display mode, so switching back shows the same read marks.
    yield* sql`CREATE TABLE IF NOT EXISTS fork_thread_sub_thread (
      thread_id TEXT NOT NULL,
      first_id TEXT NOT NULL,
      read_at TEXT,
      summary TEXT,
      PRIMARY KEY (thread_id, first_id)
    )`.pipe(Effect.orDie);
    // A position, not a count: a rollback then lowers the count the label covers by itself.
    yield* sql`CREATE TABLE IF NOT EXISTS fork_thread_sub_thread_covered (
      thread_id TEXT NOT NULL,
      first_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      turn_item_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, first_id)
    )`.pipe(Effect.orDie);
    // The wraps whose run did not store a label since the last one, so a second wrap starts none.
    yield* sql`CREATE TABLE IF NOT EXISTS fork_thread_sub_thread_tried (
      thread_id TEXT NOT NULL,
      first_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (thread_id, first_id, message_id)
    )`.pipe(Effect.orDie);
    yield* pruneDeletedThreads().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Sub-thread prune skipped", { cause })),
    );

    const load = (threadId: ThreadId) =>
      sql<SubThreadRow>`
        SELECT first_id, read_at, summary FROM fork_thread_sub_thread
        WHERE thread_id = ${threadId} ORDER BY rowid
      `.pipe(
        Effect.orDie,
        Effect.map((rows): ThreadSubThreads => ({
          threadId,
          subThreads: rows.map((row) => ({
            firstId: row.first_id,
            readAt: row.read_at,
            summary: row.summary,
          })),
        })),
      );

    // One ref per thread in use. Every write goes through the ref, which serializes the thread's
    // writes and publishes each snapshot in order; an unused ref is dropped and reloads from the table.
    const refs = yield* RcMap.make({
      lookup: (threadId: ThreadId) => load(threadId).pipe(Effect.flatMap(SubscriptionRef.make)),
    });
    const read = (threadId: ThreadId) =>
      RcMap.get(refs, threadId).pipe(Effect.flatMap(SubscriptionRef.get), Effect.scoped);
    const storeRow = (threadId: ThreadId, firstId: string, row: Omit<ThreadSubThread, "firstId">) =>
      sql`
        INSERT INTO fork_thread_sub_thread (thread_id, first_id, read_at, summary)
        VALUES (${threadId}, ${firstId}, ${row.readAt}, ${row.summary})
        ON CONFLICT (thread_id, first_id)
        DO UPDATE SET read_at = excluded.read_at, summary = excluded.summary
      `;
    const markRead: SubThreadsShape["markRead"] = Effect.fn("SubThreads.markRead")(function* ({
      threadId,
      firstId,
      readAt,
    }: Parameters<SubThreadsShape["markRead"]>[0]) {
      const ref = yield* RcMap.get(refs, threadId);
      yield* SubscriptionRef.updateSomeEffect(ref, (snapshot) =>
        Effect.gen(function* () {
          const current = snapshot.subThreads.find((entry) => entry.firstId === firstId);
          if (!isLater(readAt, current?.readAt ?? null)) return Option.none();
          yield* storeRow(threadId, firstId, { summary: null, ...current, readAt }).pipe(
            Effect.orDie,
          );
          return Option.some(withSubThread(snapshot, firstId, { readAt }));
        }),
      );
    }, Effect.scoped);

    /** The model's summary, cut to its limit, or undefined when the model was not asked. */
    const summarize = Effect.fn("SubThreads.summarize")(function* (
      threadId: ThreadId,
      firstId: string,
      seen: ReadonlyArray<VisibleCore>,
    ) {
      const message = summaryInput(seen);
      if (message.trim().length === 0) return undefined;
      const { thread } = yield* projections.getThreadRecords(threadId, []);
      const project = yield* projects.get(thread.projectId);
      if (Option.isNone(project)) return undefined;
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        thread.projectId,
      ).settings;
      // Storage cleanup removes worktrees but keeps the path; CLIs cannot spawn in a missing cwd.
      const worktreePath = thread.worktreePath;
      const worktreeExists =
        worktreePath !== null &&
        (yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)));
      const previous =
        (yield* read(threadId)).subThreads.find((entry) => entry.firstId === firstId)?.summary ??
        null;
      const result = yield* textGeneration.generateThreadTitle({
        cwd: worktreeExists ? worktreePath : project.value.workspaceRoot,
        message,
        ...(previous === null ? {} : { previousTitle: previous }),
        instructions: SUMMARY_INSTRUCTIONS,
        modelSelection: settings.textGenerationModelSelection,
      });
      return cutSummary(result.title);
    });

    // A user message item `item` of run `run` that Chat shows: typed by the user, and visible.
    const itemShown = sql`
      ${userTypedSql(sql)}
      AND (run.status IS NULL OR run.status <> 'rolled_back')
      AND NOT (
        COALESCE(
          run.status = 'queued' OR (
            run.status = 'cancelled' AND json_extract(run.payload_json, '$.startedAt') IS NULL
          ),
          0
        )
        AND json_extract(item.payload_json, '$.inputIntent') = 'queued_turn'
      )
    `;

    /**
     * Counts the sub-thread's user messages that the timeline shows, in its order, up to the wrapped
     * one and up to the covered one. No row when the wrapped one does not show.
     */
    const progressOf = Effect.fn("SubThreads.progressOf")(function* (
      threadId: ThreadId,
      firstId: string,
      wrap: Wrap,
    ) {
      const [progress] = yield* sql<{
        readonly ordinal: number;
        readonly turn_item_id: string;
        readonly text: string;
        readonly count: number;
        readonly covered: number;
        readonly tried: number;
        readonly has_covered: number;
      }>`
        WITH shown AS MATERIALIZED (
          SELECT item.ordinal, item.turn_item_id,
            json_extract(item.payload_json, '$.messageId') AS message_id,
            json_extract(item.payload_json, '$.text') AS text
          FROM orchestration_v2_projection_turn_items item
          LEFT JOIN orchestration_v2_projection_runs run ON run.run_id = item.run_id
          WHERE item.thread_id = ${threadId} AND ${itemShown}
            -- A Resume click sends an empty message; the user typed nothing.
            AND (trim(COALESCE(json_extract(item.payload_json, '$.text'), '')) <> ''
              OR json_array_length(item.payload_json, '$.attachments') > 0)
            AND (json_extract(item.payload_json, '$.messageId') = ${firstId} OR (
              item.payload_json LIKE ${`%${SUB_THREAD_RECORD_KIND}%`} AND EXISTS (
                SELECT 1 FROM json_each(item.payload_json, '$.context.records') record
                WHERE json_extract(record.value, '$.kind') = ${SUB_THREAD_RECORD_KIND}
                  AND json_extract(record.value, '$.payload.first') = ${firstId}
              )
            ))
        ),
        wrapped AS (
          SELECT ordinal, turn_item_id, text FROM shown WHERE message_id = ${wrap.messageId} LIMIT 1
        ),
        covered AS (
          SELECT ordinal, turn_item_id FROM fork_thread_sub_thread_covered
          WHERE thread_id = ${threadId} AND first_id = ${firstId}
        )
        SELECT wrapped.ordinal, wrapped.turn_item_id, wrapped.text,
          SUM(CASE WHEN (shown.ordinal, shown.turn_item_id)
            <= (wrapped.ordinal, wrapped.turn_item_id) THEN 1 ELSE 0 END) AS count,
          -- The covered message counts wherever it shows, as a redelivery may move its item.
          SUM(CASE WHEN (shown.ordinal, shown.turn_item_id) <= (covered.ordinal, covered.turn_item_id)
            OR shown.turn_item_id = covered.turn_item_id THEN 1 ELSE 0 END) AS covered,
          EXISTS (
            SELECT 1 FROM fork_thread_sub_thread_tried
            WHERE thread_id = ${threadId} AND first_id = ${firstId}
              AND message_id = ${wrap.messageId} AND text = wrapped.text
          ) AS tried,
          MAX(covered.turn_item_id IS NOT NULL) AS has_covered
        FROM wrapped
        LEFT JOIN covered ON TRUE
        JOIN shown ON TRUE
        GROUP BY wrapped.turn_item_id
      `.pipe(NodeSqliteClient.readOnly);
      return progress;
    });

    /**
     * In one transaction, and only while the wrapped item still shows with the text it had when the
     * run started: stores the covered position, and the summary when it changed.
     */
    const storeSummary = (
      threadId: ThreadId,
      firstId: string,
      covered: {
        readonly ordinal: number;
        readonly turnItemId: string;
        readonly text: string;
      },
      summary: string,
    ) =>
      RcMap.get(refs, threadId).pipe(
        Effect.flatMap((ref) =>
          SubscriptionRef.updateSomeEffect(ref, (snapshot) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const shown = yield* sql`
                  SELECT 1 FROM orchestration_v2_projection_turn_items item
                  LEFT JOIN orchestration_v2_projection_runs run ON run.run_id = item.run_id
                  WHERE item.turn_item_id = ${covered.turnItemId} AND ${itemShown}
                    AND json_extract(item.payload_json, '$.text') = ${covered.text}
                `;
                if (shown.length === 0) return Option.none();
                yield* sql`
                  INSERT INTO fork_thread_sub_thread_covered (thread_id, first_id, ordinal, turn_item_id)
                  VALUES (${threadId}, ${firstId}, ${covered.ordinal}, ${covered.turnItemId})
                  ON CONFLICT (thread_id, first_id) DO UPDATE
                  SET ordinal = excluded.ordinal, turn_item_id = excluded.turn_item_id
                  WHERE (excluded.ordinal, excluded.turn_item_id) > (
                    fork_thread_sub_thread_covered.ordinal, fork_thread_sub_thread_covered.turn_item_id
                  )
                `;
                yield* sql`
                  DELETE FROM fork_thread_sub_thread_tried
                  WHERE thread_id = ${threadId} AND first_id = ${firstId}
                `;
                const current = snapshot.subThreads.find((entry) => entry.firstId === firstId);
                if (summary.length === 0 || summary === current?.summary) return Option.none();
                yield* storeRow(threadId, firstId, { readAt: current?.readAt ?? null, summary });
                return Option.some(withSubThread(snapshot, firstId, { summary }));
              }),
            ),
          ),
        ),
        Effect.scoped,
      );

    const labelOf = (threadId: ThreadId, firstId: string) =>
      read(threadId).pipe(
        Effect.map(
          (snapshot) =>
            (snapshot.subThreads.find((entry) => entry.firstId === firstId)?.summary ?? null) !==
            null,
        ),
      );
    // A rollback hides a suffix of runs, so while the wrapped message shows, all of its thread does.
    const summarizeIfDue = Effect.fn("SubThreads.summarizeIfDue")(
      function* (threadId: ThreadId, firstId: string, wrap: Wrap) {
        const progress = yield* progressOf(threadId, firstId, wrap);
        if (
          progress === undefined ||
          progress.tried === 1 ||
          (!wrap.wrapsIt && (progress.has_covered === 1 || (yield* labelOf(threadId, firstId)))) ||
          latestSummaryCount(progress.count) <= progress.covered
        )
          return;
        yield* sql`
          INSERT INTO fork_thread_sub_thread_tried (thread_id, first_id, message_id, text)
          VALUES (${threadId}, ${firstId}, ${wrap.messageId}, ${progress.text})
          ON CONFLICT (thread_id, first_id, message_id) DO UPDATE SET text = excluded.text
        `;
        const summary = yield* summarize(threadId, firstId, wrap.thread);
        if (summary === undefined) return;
        yield* storeSummary(
          threadId,
          firstId,
          {
            ordinal: progress.ordinal,
            turnItemId: progress.turn_item_id,
            text: progress.text,
          },
          summary,
        );
      },
      (effect, threadId, firstId) =>
        effect.pipe(
          Effect.catchCause(
            logFailure("Sub-thread summary failed", { threadId, firstId }, undefined),
          ),
        ),
    );

    // A permit per sub-thread with wraps in progress, so its wraps run one at a time, in order.
    const permits = yield* RcMap.make({ lookup: (_key: string) => Semaphore.make(1) });

    const changed: SubThreadsShape["changed"] = Effect.fn("SubThreads.changed")(function* ({
      threadId,
      firstId,
      thread,
    }: Parameters<SubThreadsShape["changed"]>[0]) {
      const latest = thread.findLast((core) => core.from === "user" && core.first === firstId);
      if (latest === undefined) return;
      const key = `${threadId.length}:${threadId}${firstId}`;
      const wrap: Wrap = { thread, messageId: latest.id, wrapsIt: latest === thread.at(-1) };
      yield* RcMap.get(permits, key).pipe(
        Effect.flatMap((permit) =>
          summarizeIfDue(threadId, firstId, wrap).pipe(permit.withPermits(1)),
        ),
        Effect.scoped,
        Effect.forkIn(layerScope),
      );
    });

    const changes: SubThreadsShape["changes"] = (threadId) =>
      Stream.unwrap(RcMap.get(refs, threadId).pipe(Effect.map(SubscriptionRef.changes)));

    return SubThreads.of({ changes, markRead, changed });
  }),
);

export const layer = layerFromServices.pipe(
  Layer.provide(Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer, TextGeneration.layer)),
);

const idle = SubThreads.of({
  changes: (threadId) => Stream.succeed({ threadId, subThreads: [] }),
  markRead: Effect.fn("SubThreads.markReadIdle")(() => Effect.void),
  changed: Effect.fn("SubThreads.changedIdle")(() => Effect.void),
});

/** The provided service. A runtime without one, such as a test of the calling service, keeps nothing. */
export const orIdle = Effect.serviceOption(SubThreads).pipe(
  Effect.map(Option.getOrElse(() => idle)),
);
