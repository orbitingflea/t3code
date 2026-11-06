import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { projectLocationFlags, resolveCliAuthConfig } from "../../cli/config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { DatabaseMissingError } from "../../persistence/DatabaseMaintenance.ts";
import {
  planWorkerThreadPrune,
  pruneWorkerThreads,
  WORKER_CONTENT_TABLES,
  WORKER_THREAD_IDLE_TIME,
  type WorkerContentRows,
} from "./workerThreadPrune.ts";

const IDLE_DAYS = Duration.toDays(WORKER_THREAD_IDLE_TIME);

const formatMiB = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

const formatRows = (rows: WorkerContentRows) =>
  WORKER_CONTENT_TABLES.map((table) => `  ${table}: ${rows[table]}`).join("\n");

const runPruneWorkerThreads = Effect.fn("runPruneWorkerThreads")(function* (options: {
  readonly dryRun: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  // A running server writes at the same time; wait out its short transactions as it waits out ours.
  yield* sql`PRAGMA busy_timeout = 5000`;
  const plan = yield* planWorkerThreadPrune();
  yield* Console.log(
    `Worker threads idle ${IDLE_DAYS} days with content: ${plan.threadIds.length} of ${plan.workerThreadCount} worker threads; ${plan.keptThreadCount} more kept for recovery, a child or a fork.\n${formatRows(plan.rows)}\nRow data: ${formatMiB(plan.rowBytes)}; indexes free more.`,
  );
  if (options.dryRun || plan.threadIds.length === 0) {
    yield* Console.log(options.dryRun ? "Dry run: nothing changed." : "Nothing to delete.");
    return;
  }
  const result = yield* pruneWorkerThreads(plan);
  yield* Console.log(
    `Deleted the content of ${result.prunedThreadCount} threads${
      result.skippedThreadCount > 0
        ? `; kept ${result.skippedThreadCount} that became active or needed again`
        : ""
    }.\n${formatRows(result.rows)}\nUsed space: ${formatMiB(result.usedBytesBefore)} -> ${formatMiB(result.usedBytesAfter)}. ${
      result.incrementalVacuum
        ? "A running server returns the freed pages to disk over the next hours."
        : "Later writes reuse the freed pages; the file shrinks only when `t3 doctor` reclaims database space."
    }`,
  );
});

export const pruneWorkerThreadsCommand = Command.make("prune-worker-threads", {
  ...projectLocationFlags,
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Report what would be deleted without changing anything."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    `Delete the messages and turn items of agent-started worker threads idle for ${IDLE_DAYS} days. Keeps the threads, their runs, pull request links and parent links. Deletes each thread's messages and turn items in its own short transaction, which first checks again that the thread and its children and forks, and theirs, are still idle.`,
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(config.dbPath))) {
        return yield* new DatabaseMissingError({ path: config.dbPath });
      }
      yield* runPruneWorkerThreads({ dryRun: flags.dryRun }).pipe(
        Effect.provide(
          ProjectionStore.layer.pipe(
            Layer.provideMerge(NodeSqliteClient.layer({ filename: config.dbPath })),
          ),
        ),
      );
    }),
  ),
);
