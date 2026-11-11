import type { ThreadId, ThreadSubThread, ThreadSubThreads } from "@t3tools/contracts";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import { subThreadRecap, type VisibleCore } from "@t3tools/shared/displayModes";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RcMap from "effect/RcMap";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
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
   * What the user sees in the sub-thread changed. Starts one summary run in the background and
   * returns at once; it never fails. `thread` is the sub-thread's messages as the user now sees
   * them, the first message first.
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
// How many inputs `summarized` keeps. It only saves a repeated run, so a dropped input costs one.
const SUMMARIZED_KEPT = 200;

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
  yield* sql`DELETE FROM fork_thread_sub_thread WHERE thread_id IN (
    SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL
  )`;
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
    /** Stores and publishes the fields that `fieldsFor` gives for the sub-thread, or nothing when it gives none. */
    const write = (
      threadId: ThreadId,
      firstId: string,
      fieldsFor: (
        current: ThreadSubThread | undefined,
      ) => Partial<Omit<ThreadSubThread, "firstId">> | undefined,
    ) =>
      RcMap.get(refs, threadId).pipe(
        Effect.flatMap((ref) =>
          SubscriptionRef.updateSomeEffect(ref, (snapshot) =>
            Effect.gen(function* () {
              const current = snapshot.subThreads.find((entry) => entry.firstId === firstId);
              const fields = fieldsFor(current);
              if (fields === undefined) return Option.none();
              const next = { readAt: null, summary: null, ...current, ...fields };
              yield* sql`
                INSERT INTO fork_thread_sub_thread (thread_id, first_id, read_at, summary)
                VALUES (${threadId}, ${firstId}, ${next.readAt}, ${next.summary})
                ON CONFLICT (thread_id, first_id)
                DO UPDATE SET read_at = excluded.read_at, summary = excluded.summary
              `.pipe(Effect.orDie);
              return Option.some(withSubThread(snapshot, firstId, fields));
            }),
          ),
        ),
        Effect.scoped,
      );

    const markRead: SubThreadsShape["markRead"] = Effect.fn("SubThreads.markRead")(function* ({
      threadId,
      firstId,
      readAt,
    }: Parameters<SubThreadsShape["markRead"]>[0]) {
      yield* write(threadId, firstId, (current) =>
        isLater(readAt, current?.readAt ?? null) ? { readAt } : undefined,
      );
    });

    /** The input of each sub-thread's last summary run that gave a title, for the latest few. */
    const summarized = new Map<string, string>();
    const summarize = Effect.fn("SubThreads.summarize")(function* (
      threadId: ThreadId,
      firstId: string,
      seen: ReadonlyArray<VisibleCore>,
    ) {
      const message = summaryInput(seen);
      // A turn start may wrap the same message twice; the second input equals the first.
      const key = `${threadId.length}:${threadId}${firstId}`;
      if (message.trim().length === 0 || summarized.get(key) === message) return;
      const { thread } = yield* projections.getThreadRecords(threadId, []);
      const project = yield* projects.get(thread.projectId);
      if (Option.isNone(project)) return;
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
      summarized.delete(key);
      summarized.set(key, message);
      for (const oldest of summarized.keys()) {
        if (summarized.size <= SUMMARIZED_KEPT) break;
        summarized.delete(oldest);
      }
      const summary = cutSummary(result.title);
      yield* write(threadId, firstId, (current) =>
        summary.length === 0 || summary === current?.summary ? undefined : { summary },
      );
    });

    // A key is here while its sub-thread has a run. Its value is the messages of the one run owed after it.
    const runs = new Map<string, ReadonlyArray<VisibleCore> | undefined>();
    const runUntilSettled = Effect.fn("SubThreads.runUntilSettled")(function* (
      threadId: ThreadId,
      firstId: string,
      key: string,
      firstThread: ReadonlyArray<VisibleCore>,
    ) {
      let thread: ReadonlyArray<VisibleCore> | undefined = firstThread;
      while (thread !== undefined) {
        yield* summarize(threadId, firstId, thread).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("Sub-thread summary failed", { threadId, firstId, cause }),
          ),
        );
        thread = runs.get(key);
        // In one step with the read above, so a `changed` call can never add messages to a run that ended.
        if (thread === undefined) runs.delete(key);
        else runs.set(key, undefined);
      }
    });

    const changed: SubThreadsShape["changed"] = Effect.fn("SubThreads.changed")(function* ({
      threadId,
      firstId,
      thread,
    }: Parameters<SubThreadsShape["changed"]>[0]) {
      const key = `${threadId.length}:${threadId}${firstId}`;
      if (runs.has(key)) {
        runs.set(key, thread);
        return;
      }
      runs.set(key, undefined);
      yield* runUntilSettled(threadId, firstId, key, thread).pipe(Effect.forkIn(layerScope));
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
