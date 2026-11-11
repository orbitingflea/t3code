import { assert, it } from "@effect/vitest";
import { ProjectId, TextGenerationError, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import type { VisibleCore } from "@t3tools/shared/displayModes";
import * as SubThreads from "./SubThreads.ts";

const threadId = ThreadId.make("thread:sub-threads");
const said = (from: "user" | "agent", text: string): VisibleCore => ({
  id: text,
  from,
  text,
  first: "m1",
  reply: from === "agent",
});
const otherId = ThreadId.make("thread:sub-threads:other");
const projectId = ProjectId.make("project:sub-threads");

/** One call to the title generator, held until the test answers it. */
interface GenerationCall {
  readonly input: TextGeneration.ThreadTitleGenerationInput;
  readonly answer: Deferred.Deferred<string, TextGenerationError>;
}

const layerFor = (calls: Queue.Queue<GenerationCall>) =>
  SubThreads.layerFromServices.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(TextGeneration.TextGeneration)({
          generateThreadTitle: (input) =>
            Effect.gen(function* () {
              const answer = yield* Deferred.make<string, TextGenerationError>();
              yield* Queue.offer(calls, { input, answer });
              return { title: yield* Deferred.await(answer) };
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () =>
            Effect.succeed({ thread: { projectId, worktreePath: null } } as never),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
              projectId,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              pinnedAt: null,
              archivedAt: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
        }),
        ServerSettings.layerTest({}),
        FileSystem.layerNoop({}),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const withSubThreads = <A, E, R>(
  body: (
    subThreads: SubThreads.SubThreadsShape,
    calls: Queue.Queue<GenerationCall>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<GenerationCall>();
    return yield* SubThreads.SubThreads.pipe(
      Effect.flatMap((subThreads) => body(subThreads, calls)),
      Effect.provide(layerFor(calls)),
    );
  }).pipe(Effect.scoped);

const current = (subThreads: SubThreads.SubThreadsShape, id: ThreadId) =>
  subThreads.changes(id).pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((snapshots) => Array.from(snapshots)[0]?.subThreads),
  );

/** Subscribes, then gives an effect that waits for `count` snapshots of the thread, the current one first. */
const collect = (subThreads: SubThreads.SubThreadsShape, count: number) =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    const collected = yield* subThreads.changes(threadId).pipe(
      Stream.tap(() => Deferred.succeed(subscribed, undefined)),
      Stream.take(count),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(subscribed);
    return Fiber.join(collected).pipe(
      Effect.map((snapshots) => Array.from(snapshots, (snapshot) => snapshot.subThreads)),
    );
  });

const failure = new TextGenerationError({ operation: "generateThreadTitle", detail: "No model." });

it.effect("keeps the later read time of a sub-thread and publishes each change", () =>
  withSubThreads((subThreads) =>
    Effect.gen(function* () {
      const snapshots = yield* collect(subThreads, 3);
      yield* subThreads.markRead({ threadId, firstId: "m1", readAt: "2026-01-02T00:00:00.000Z" });
      yield* subThreads.markRead({ threadId, firstId: "m1", readAt: "2026-01-01T00:00:00.000Z" });
      yield* subThreads.markRead({ threadId, firstId: "m1", readAt: "not a time" });
      yield* subThreads.markRead({ threadId, firstId: "m1", readAt: "2026-01-03T00:00:00.000Z" });
      assert.deepEqual(yield* snapshots, [
        [],
        [{ firstId: "m1", readAt: "2026-01-02T00:00:00.000Z", summary: null }],
        [{ firstId: "m1", readAt: "2026-01-03T00:00:00.000Z", summary: null }],
      ]);
    }),
  ),
);

it.effect("keeps the sub-threads of each thread apart", () =>
  withSubThreads((subThreads) =>
    Effect.gen(function* () {
      yield* subThreads.markRead({ threadId, firstId: "m1", readAt: "2026-01-02T00:00:00.000Z" });
      yield* subThreads.markRead({ threadId, firstId: "m2", readAt: "2026-01-04T00:00:00.000Z" });
      yield* subThreads.markRead({
        threadId: otherId,
        firstId: "m1",
        readAt: "2026-01-03T00:00:00.000Z",
      });
      assert.deepEqual(yield* current(subThreads, threadId), [
        { firstId: "m1", readAt: "2026-01-02T00:00:00.000Z", summary: null },
        { firstId: "m2", readAt: "2026-01-04T00:00:00.000Z", summary: null },
      ]);
      assert.deepEqual(yield* current(subThreads, otherId), [
        { firstId: "m1", readAt: "2026-01-03T00:00:00.000Z", summary: null },
      ]);
    }),
  ),
);

it.effect("writes a summary from the title generator, cut to its limit, and publishes it", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const readAt = "2026-01-02T00:00:00.000Z";
      yield* subThreads.markRead({ threadId, firstId: "m1", readAt });
      const snapshots = yield* collect(subThreads, 3);

      yield* subThreads.changed({
        threadId,
        firstId: "m1",
        thread: [
          said("user", "Why is CI red?"),
          said("agent", "one"),
          said("user", "two"),
          said("agent", "three"),
          said("agent", "A lint."),
        ],
      });
      const first = yield* Queue.take(calls);
      // The first message and the latest three, in the form the thread title model gets.
      assert.strictEqual(
        first.input.message,
        "USER:\nWhy is CI red?\n\nUSER:\ntwo\n\nASSISTANT:\nthree\n\nASSISTANT:\nA lint.",
      );
      assert.strictEqual(first.input.cwd, "/repo");
      assert.strictEqual(first.input.previousTitle, undefined);
      const settings = yield* ServerSettings.ServerSettingsService;
      assert.deepEqual(
        first.input.modelSelection,
        (yield* settings.getSettings).textGenerationModelSelection,
      );
      yield* Deferred.succeed(first.answer, "  Red CI from\n a lint rule ");

      yield* subThreads.changed({
        threadId,
        firstId: "m1",
        thread: [said("user", "Why is CI red?"), said("agent", "Fixed.")],
      });
      const second = yield* Queue.take(calls);
      assert.strictEqual(second.input.previousTitle, "Red CI from a lint rule");
      yield* Deferred.succeed(second.answer, "字".repeat(100));

      assert.deepEqual(yield* snapshots, [
        [{ firstId: "m1", readAt, summary: null }],
        [{ firstId: "m1", readAt, summary: "Red CI from a lint rule" }],
        [{ firstId: "m1", readAt, summary: "字".repeat(80) }],
      ]);
    }),
  ),
);

it.effect("runs once more with the latest messages after changes during a run", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const snapshots = yield* collect(subThreads, 5);
      const changed = (firstId: string, line: string) =>
        subThreads.changed({ threadId, firstId, thread: [said("user", line)] });

      yield* changed("m1", "one");
      const one = yield* Queue.take(calls);
      yield* changed("m1", "two");
      yield* changed("m1", "three");

      yield* changed("m2", "other");
      const other = yield* Queue.take(calls);
      assert.strictEqual(other.input.message, "USER:\nother");

      yield* Deferred.succeed(one.answer, "First");
      const three = yield* Queue.take(calls);
      assert.strictEqual(three.input.message, "USER:\nthree");
      assert.strictEqual(three.input.previousTitle, "First");
      yield* Deferred.succeed(three.answer, "Second");

      yield* changed("m1", "four");
      const four = yield* Queue.take(calls);
      assert.strictEqual(four.input.message, "USER:\nfour");
      assert.strictEqual(four.input.previousTitle, "Second");
      yield* Deferred.succeed(four.answer, "Fourth");
      yield* Deferred.succeed(other.answer, "Other");
      // The same messages again start no run: the next call is the other sub-thread's.
      yield* changed("m1", "four");
      yield* changed("m2", "more");
      const more = yield* Queue.take(calls);
      assert.strictEqual(more.input.message, "USER:\nmore");
      yield* Deferred.succeed(more.answer, "Other");

      assert.deepEqual((yield* snapshots).at(-1), [
        { firstId: "m1", readAt: null, summary: "Fourth" },
        { firstId: "m2", readAt: null, summary: "Other" },
      ]);
    }),
  ),
);

it.effect("keeps the summary when a run fails, and runs again on the next change", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const snapshots = yield* collect(subThreads, 3);
      const changed = (line: string) =>
        subThreads.changed({ threadId, firstId: "m1", thread: [said("user", line)] });

      yield* changed("one");
      yield* Deferred.succeed((yield* Queue.take(calls)).answer, "First");
      yield* changed("two");
      yield* Deferred.fail((yield* Queue.take(calls)).answer, failure);
      yield* changed("three");
      const third = yield* Queue.take(calls);
      assert.strictEqual(third.input.previousTitle, "First");
      yield* Deferred.succeed(third.answer, "Third");

      assert.deepEqual(yield* snapshots, [
        [],
        [{ firstId: "m1", readAt: null, summary: "First" }],
        [{ firstId: "m1", readAt: null, summary: "Third" }],
      ]);
    }),
  ),
);

it.effect("keeps a thread's rows across restarts and drops a deleted thread's", () =>
  withSubThreads((subThreads) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const readAt = "2026-01-02T00:00:00.000Z";
      for (const [id, deletedAt] of [
        [threadId, null],
        [otherId, "2026-01-02T00:00:00.000Z"],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
          default_provider, runtime_mode, interaction_mode, created_at, updated_at, deleted_at,
          payload_json)
          VALUES (${id}, 'project', 'Thread', 'codex', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${deletedAt}, '{}')`;
        yield* subThreads.markRead({ threadId: id, firstId: "m1", readAt });
      }

      const restarted = Context.get(
        yield* Layer.build(Layer.fresh(SubThreads.layerFromServices)),
        SubThreads.SubThreads,
      );
      assert.deepEqual(yield* current(restarted, threadId), [
        { firstId: "m1", readAt, summary: null },
      ]);
      assert.deepEqual(yield* current(restarted, otherId), []);
    }),
  ),
);
