import { assert, it } from "@effect/vitest";
import { ProjectId, TextGenerationError, ThreadId } from "@t3tools/contracts";
import { SUB_THREAD_RECORD_KIND, type VisibleCore } from "@t3tools/shared/displayModes";
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
const createdAt = "2026-01-01T00:00:00.000Z";

interface UserMessage {
  readonly id: string;
  readonly first?: string;
  readonly runId?: string;
  readonly threadId?: ThreadId;
  readonly text?: string;
  readonly creationSource?: string;
}

/** The fields that a user message and the turn item that shows it both carry. */
const userPayload = (message: UserMessage) => ({
  createdBy: "user",
  creationSource: message.creationSource ?? "web",
  text: message.text ?? message.id,
  attachments: [],
  context: {
    records:
      message.first === undefined
        ? []
        : [{ kind: SUB_THREAD_RECORD_KIND, payload: { first: message.first } }],
  },
});

/** Stores the turn item that shows `message`, after every stored item. */
const storeUserItem = (message: UserMessage, inputIntent: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        ${`item:${message.id}`}, ${message.threadId ?? threadId}, ${message.runId ?? null},
        (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM orchestration_v2_projection_turn_items), 'user_message',
        'completed', ${createdAt},
        ${JSON.stringify({ messageId: message.id, inputIntent, ...userPayload(message) })}
      )
    `;
  });

/**
 * Stores a user message, a reply under `first` when given, and the turn item that shows it with
 * `inputIntent`, after every stored item. A message that a run has not taken yet has no item (null).
 */
const storeUserMessage = (message: UserMessage & { readonly inputIntent?: string | null }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json
      ) VALUES (
        ${message.id}, ${message.threadId ?? threadId}, ${message.runId ?? null}, 'user', 0,
        ${createdAt}, ${createdAt}, ${JSON.stringify(userPayload(message))}
      )
    `;
    const inputIntent = message.inputIntent === undefined ? "turn_start" : message.inputIntent;
    if (inputIntent !== null) yield* storeUserItem(message, inputIntent);
  });

const storeTurnItem = (turnItemId: string, runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        ${turnItemId}, ${threadId}, ${runId},
        (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM orchestration_v2_projection_turn_items), 'dynamic_tool_call',
        'completed', ${createdAt}, '{}'
      )
    `;
  });

const storeRun = (runId: string, status: "rolled_back" | "cancelled" | "queued") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (
        ${runId}, ${threadId}, (SELECT COUNT(*) FROM orchestration_v2_projection_runs), 'codex',
        ${status}, '2026-01-01T00:00:00.000Z', '{}'
      )
    `;
  });

/**
 * A sub-thread whose first message `root` sent, where answer n answers reply n and is in its run.
 * Each step stores what the projection then holds and gives what a caller passes, cut to the latest
 * `window` messages.
 */
const subThread = (root: "user" | "agent", window = 120) =>
  Effect.gen(function* () {
    const firstId = `${root}-root`;
    const core = (id: string, from: "user" | "agent", text: string): VisibleCore => ({
      id,
      from,
      text,
      first: firstId,
      reply: true,
    });
    let shown: ReadonlyArray<VisibleCore> = [{ ...core(firstId, root, "Root."), reply: false }];
    if (root === "user") yield* storeUserMessage({ id: firstId });
    const cut = (thread: ReadonlyArray<VisibleCore>) => thread.slice(-window);
    const replyId = (n: number) =>
      shown.findLast((entry) => entry.from === "user" && entry.text === `reply ${n}.`)?.id ??
      `${firstId}:u${n}`;
    return {
      firstId,
      replyId,
      /** What the user sees now. */
      current: () => cut(shown),
      /** Stores reply n, or a replacement of a rolled-back one, and gives its wrap. */
      reply: (n: number, replacement = false) =>
        Effect.gen(function* () {
          const id = `${firstId}:u${n}${replacement ? "-again" : ""}`;
          yield* storeUserMessage({ id, first: firstId, runId: `run:${id}` });
          shown = [...shown, core(id, "user", `reply ${n}.`)];
          return cut(shown);
        }),
      /** Stores answer n and gives its send, read before any later reply. */
      answer: (n: number) =>
        Effect.gen(function* () {
          const to = replyId(n);
          const id = to.replace(":u", ":a");
          yield* storeTurnItem(id, `run:${to}`);
          const send = [...cut(shown), core("", "agent", `answer ${n}.`)];
          shown = [...shown, core(id, "agent", `answer ${n}.`)];
          return send;
        }),
      /** A rewrite of answer n. */
      rewrite: (n: number) =>
        cut(
          shown.map((entry) =>
            entry.from === "agent" && entry.text === `answer ${n}.`
              ? { ...entry, text: `answer ${n}, edited.` }
              : entry,
          ),
        ),
      /** Rolls back the run of each reply n, which hides the reply and its answer. */
      rollBack: (...replies: ReadonlyArray<number>) =>
        Effect.gen(function* () {
          for (const n of replies) {
            const id = replyId(n);
            yield* storeRun(`run:${id}`, "rolled_back");
            shown = shown.filter((entry) => entry.id !== id && entry.id !== id.replace(":u", ":a"));
          }
        }),
      /** Stores reply n in a run with `status` that never started, which shows no wrap. */
      undelivered: (n: number, status: "cancelled" | "queued", inputIntent: string | null) =>
        Effect.gen(function* () {
          const id = `${firstId}:u${n}`;
          yield* storeUserMessage({ id, first: firstId, runId: `run:${id}`, inputIntent });
          yield* storeRun(`run:${id}`, status);
        }),
      /** Stores reply n in a queued run, whose turn item comes when the run starts. */
      queue: (n: number) =>
        Effect.gen(function* () {
          const id = `${firstId}:u${n}`;
          yield* storeUserMessage({ id, first: firstId, runId: `run:${id}`, inputIntent: null });
          yield* storeRun(`run:${id}`, "queued");
        }),
      /** Starts the queued run of reply n, after every stored item, and gives its wrap. */
      start: (n: number) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const id = `${firstId}:u${n}`;
          yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'running'
            WHERE run_id = ${`run:${id}`}`;
          yield* storeUserItem({ id, first: firstId, runId: `run:${id}` }, "queued_turn");
          shown = [...shown, core(id, "user", `reply ${n}.`)];
          return cut(shown);
        }),
      /** Stores reply n as a message that the server made for the user, which Chat does not show. */
      madeByServer: (n: number) =>
        storeUserMessage({ id: `${firstId}:u${n}`, first: firstId, creationSource: "server" }),
      /** Stores the empty reply that a Resume click sends and gives its wrap. */
      resume: (n: number) =>
        Effect.gen(function* () {
          const id = `${firstId}:resume${n}`;
          yield* storeUserMessage({ id, first: firstId, text: "" });
          return [...cut(shown), core(id, "user", "")];
        }),
    };
  });

type SubThreadFixture = Effect.Success<ReturnType<typeof subThread>>;

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
              hasCustomTitle: false,
              workspaceRoot: "/repo",
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              trackedFolders: [],
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

/** Takes the next summary run, which must be for reply `n` with `previous` as the previous summary. */
const nextRun = (calls: Queue.Queue<GenerationCall>, n: number, previous?: string) =>
  Effect.gen(function* () {
    const call = yield* Queue.take(calls);
    const lastUserText = call.input.message
      .split("\n\n")
      .findLast((section) => section.startsWith("USER:\n"))
      ?.slice("USER:\n".length);
    assert.strictEqual(lastUserText, `reply ${n}.`);
    assert.strictEqual(call.input.previousTitle, previous);
    return call;
  });

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

      for (const id of ["Why is CI red?", "A lint?"]) yield* storeUserMessage({ id, first: "m1" });
      yield* subThreads.changed({
        threadId,
        firstId: "m1",
        thread: [
          said("user", "Why is CI red?"),
          said("agent", "one"),
          said("agent", "two"),
          said("agent", "three"),
          said("user", "A lint?"),
        ],
      });
      const first = yield* Queue.take(calls);
      // The first message and the latest three, in the form the thread title model gets.
      assert.strictEqual(
        first.input.message,
        "USER:\nWhy is CI red?\n\nASSISTANT:\ntwo\n\nASSISTANT:\nthree\n\nUSER:\nA lint?",
      );
      assert.strictEqual(first.input.cwd, "/repo");
      assert.strictEqual(first.input.previousTitle, undefined);
      const settings = yield* ServerSettings.ServerSettingsService;
      assert.deepEqual(
        first.input.modelSelection,
        (yield* settings.getSettings).textGenerationModelSelection,
      );
      yield* Deferred.succeed(first.answer, "  Red CI from\n a lint rule ");

      yield* storeUserMessage({ id: "Thanks.", first: "m1" });
      yield* subThreads.changed({
        threadId,
        firstId: "m1",
        thread: [
          said("user", "Why is CI red?"),
          said("agent", "one"),
          said("agent", "two"),
          said("agent", "three"),
          said("user", "A lint?"),
          said("agent", "Fixed."),
          said("user", "Thanks."),
        ],
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

/** Takes the run for reply `n`, answers it with "Summary n", and gives that summary. */
const summarizeAt = (calls: Queue.Queue<GenerationCall>, n: number, previous?: string) =>
  Effect.gen(function* () {
    const summary = `Summary ${n}`;
    yield* Deferred.succeed((yield* nextRun(calls, n, previous)).answer, summary);
    return summary;
  });

/**
 * Sends replies `from` to `to` through `changed`, each after the answer to and a rewrite of the
 * reply before, and answers the run at each of `runs`. Gives the last summary.
 */
const replyThrough = (
  sub: SubThreadFixture,
  changed: (thread: ReadonlyArray<VisibleCore>) => Effect.Effect<void>,
  calls: Queue.Queue<GenerationCall>,
  replies: { readonly from: number; readonly to: number },
  runs: ReadonlyArray<number>,
  previous?: string,
) =>
  Effect.gen(function* () {
    let summary = previous;
    for (let n = replies.from; n <= replies.to; n++) {
      if (n > 1) {
        yield* changed(yield* sub.answer(n - 1));
        yield* changed(sub.rewrite(n - 1));
      }
      yield* changed(yield* sub.reply(n));
      if (runs.includes(n)) summary = yield* summarizeAt(calls, n, summary);
    }
    return summary;
  });

const changedIn =
  (subThreads: SubThreads.SubThreadsShape, firstId: string) =>
  (thread: ReadonlyArray<VisibleCore>) =>
    subThreads.changed({ threadId, firstId, thread });

it.effect.each([
  { root: "agent" as const, runs: [1, 3, 6, 10, 20, 30] },
  { root: "user" as const, runs: [1, 2, 5, 9, 19, 29] },
])(
  "summarizes at user messages 1, 3, 6, 10 and each 10 after, $root first message",
  ({ root, runs }) =>
    withSubThreads((subThreads, calls) =>
      Effect.gen(function* () {
        const sub = yield* subThread(root, 6);
        // The answers and rewrites between replies start no run: each run taken is the next expected one.
        yield* replyThrough(
          sub,
          changedIn(subThreads, sub.firstId),
          calls,
          { from: 1, to: Math.max(...runs) },
          runs,
        );
      }),
    ),
);

it.effect("runs each due wrap from a run's time in order, and a second wrap starts none", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const snapshots = yield* collect(subThreads, 5);
      const sub = yield* subThread("agent", 6);
      const other = yield* subThread("user");
      const changed = changedIn(subThreads, sub.firstId);

      yield* changed(yield* sub.reply(1));
      const one = yield* nextRun(calls, 1);
      yield* changed(yield* sub.reply(2));
      const three = yield* sub.reply(3);
      yield* changed(three);
      yield* changed(yield* sub.answer(3));
      yield* changed(yield* sub.reply(4));
      yield* changed(three);
      yield* changed(yield* sub.reply(5));
      yield* changed(yield* sub.reply(6));

      yield* changedIn(subThreads, other.firstId)(yield* other.reply(1));
      const otherRun = yield* Queue.take(calls);
      assert.strictEqual(otherRun.input.message, "USER:\nRoot.\n\nUSER:\nreply 1.");

      yield* Deferred.succeed(one.answer, "First");
      yield* Deferred.succeed((yield* nextRun(calls, 3, "First")).answer, "Third");
      yield* Deferred.succeed(otherRun.answer, "Other");
      yield* Deferred.succeed((yield* nextRun(calls, 6, "Third")).answer, "Sixth");
      yield* replyThrough(sub, changed, calls, { from: 7, to: 10 }, [10], "Sixth");

      assert.deepEqual((yield* snapshots).at(-1), [
        { firstId: sub.firstId, readAt: null, summary: "Sixth" },
        { firstId: other.firstId, readAt: null, summary: "Other" },
      ]);
    }),
  ),
);

it.effect("retries a failed run at the next user message and takes a blank answer as done", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const snapshots = yield* collect(subThreads, 4);
      const sub = yield* subThread("agent");
      const changed = changedIn(subThreads, sub.firstId);

      yield* changed(yield* sub.reply(1));
      yield* Deferred.succeed((yield* nextRun(calls, 1)).answer, "First");
      yield* changed(yield* sub.reply(2));
      const three = yield* sub.reply(3);
      yield* changed(three);
      const third = yield* nextRun(calls, 3, "First");
      // A turn start may wrap the same message again.
      yield* changed(three);
      yield* Deferred.fail(third.answer, failure);
      yield* changed(yield* sub.answer(3));
      yield* changed(yield* sub.reply(4));
      yield* Deferred.fail((yield* nextRun(calls, 4, "First")).answer, failure);
      // A declined steer comes back from the queue and is wrapped again.
      yield* changed(three);
      yield* changed(yield* sub.reply(5));
      yield* Deferred.succeed((yield* nextRun(calls, 5, "First")).answer, "Fifth");
      yield* changed(yield* sub.reply(6));
      yield* Deferred.succeed((yield* nextRun(calls, 6, "Fifth")).answer, "  ");
      for (const n of [7, 8, 9, 10]) yield* changed(yield* sub.reply(n));
      yield* Deferred.succeed((yield* nextRun(calls, 10, "Fifth")).answer, "Tenth");

      assert.deepEqual(yield* snapshots, [
        [],
        [{ firstId: sub.firstId, readAt: null, summary: "First" }],
        [{ firstId: sub.firstId, readAt: null, summary: "Fifth" }],
        [{ firstId: sub.firstId, readAt: null, summary: "Tenth" }],
      ]);
    }),
  ),
);

it.effect("counts replies that reached no wrap, and an agent answer starts no run", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const sub = yield* subThread("agent");
      const changed = changedIn(subThreads, sub.firstId);

      yield* changed(yield* sub.reply(1));
      yield* Deferred.succeed((yield* nextRun(calls, 1)).answer, "First");
      yield* sub.reply(2);
      yield* sub.reply(3);
      yield* changed(yield* sub.answer(3));
      yield* changed(yield* sub.reply(4));
      yield* Deferred.succeed((yield* nextRun(calls, 4, "First")).answer, "Fourth");
    }),
  ),
);

it.effect.each([
  { hidden: "reply 4", rolledBack: [4] },
  { hidden: "replies 4 and 5", rolledBack: [4, 5] },
])(
  "leaves out of the prompt and the count $hidden, which a rollback during a run hid",
  ({ rolledBack }) =>
    withSubThreads((subThreads, calls) =>
      Effect.gen(function* () {
        const sub = yield* subThread("agent");
        const changed = changedIn(subThreads, sub.firstId);

        yield* changed(yield* sub.reply(1));
        const one = yield* nextRun(calls, 1);
        yield* replyThrough(sub, changed, calls, { from: 2, to: Math.max(...rolledBack) }, []);
        yield* sub.rollBack(...rolledBack);
        yield* Deferred.succeed(one.answer, "First");
        const third = yield* nextRun(calls, 3, "First");
        assert.notInclude(third.input.message, "answer 4.");
        yield* Deferred.succeed(third.answer, "Third");

        // The run covers user message 3, so the replacements are user messages 4 and 5.
        yield* changed(yield* sub.reply(4, true));
        yield* changed(yield* sub.reply(5, true));
        yield* changed(yield* sub.reply(6));
        yield* Deferred.succeed((yield* nextRun(calls, 6, "Third")).answer, "Sixth");
      }),
    ),
);

it.effect.each([
  { hidden: "rolled-back replies 9 and 10", replies: 10, runs: [1, 3, 6, 10], rolledBack: [9, 10] },
  { hidden: "a rolled-back only reply", replies: 1, runs: [1], rolledBack: [1] },
])(
  "counts $hidden no more, so the last replacement summarizes again",
  ({ replies, runs, rolledBack }) =>
    withSubThreads((subThreads, calls) =>
      Effect.gen(function* () {
        const sub = yield* subThread("agent");
        const changed = changedIn(subThreads, sub.firstId);

        const previous = yield* replyThrough(sub, changed, calls, { from: 1, to: replies }, runs);
        yield* sub.rollBack(...rolledBack);
        for (const [index, n] of rolledBack.entries()) {
          yield* changed(yield* sub.reply(n, true));
          if (index === rolledBack.length - 1) yield* summarizeAt(calls, n, previous);
        }
      }),
    ),
);

it.effect.each([
  { what: "a reply taken off the queue", status: "cancelled", item: null, counts: false },
  { what: "a reply in the queue", status: "queued", item: null, counts: false },
  { what: "a steer back in the queue", status: "queued", item: "queued_turn", counts: false },
  {
    what: "a reply cancelled before its run started",
    status: "cancelled",
    item: "turn_start",
    counts: true,
  },
  { what: "a Resume click", status: undefined, item: null, counts: false },
  { what: "a message the server made", status: undefined, item: "server", counts: false },
] as const)("counts $what as the user sees it", ({ status, item, counts }) =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const sub = yield* subThread("agent");
      const changed = changedIn(subThreads, sub.firstId);

      yield* changed(yield* sub.reply(1));
      yield* Deferred.succeed((yield* nextRun(calls, 1)).answer, "First");
      if (item === "server") yield* sub.madeByServer(2);
      else if (status === undefined) yield* changed(yield* sub.resume(2));
      else yield* sub.undelivered(2, status, item);
      yield* changed(yield* sub.reply(3));
      yield* changed(yield* sub.reply(4));
      yield* summarizeAt(calls, counts ? 3 : 4, "First");
    }),
  ),
);

it.effect("drops a summary of a reply that a rollback hid during the model call", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const snapshots = yield* collect(subThreads, 2);
      const sub = yield* subThread("agent");
      const changed = changedIn(subThreads, sub.firstId);

      yield* changed(yield* sub.reply(1));
      const one = yield* nextRun(calls, 1);
      yield* sub.rollBack(1);
      yield* Deferred.succeed(one.answer, "Hidden");
      yield* changed(yield* sub.reply(1, true));
      yield* summarizeAt(calls, 1);

      assert.deepEqual(yield* snapshots, [
        [],
        [{ firstId: sub.firstId, readAt: null, summary: "Summary 1" }],
      ]);
    }),
  ),
);

it.effect("starts no run for a wrap that a rollback hid before its turn", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const sub = yield* subThread("agent");
      const changed = changedIn(subThreads, sub.firstId);

      yield* changed(yield* sub.reply(1));
      const one = yield* nextRun(calls, 1);
      for (const n of [2, 3, 4]) yield* changed(yield* sub.reply(n));
      yield* sub.rollBack(4);
      yield* Deferred.succeed(one.answer, "First");
      // Reply 4 still counts to 3 without itself, which the failed run leaves due.
      yield* Deferred.fail((yield* nextRun(calls, 3, "First")).answer, failure);
      yield* changed(yield* sub.reply(5));
      yield* summarizeAt(calls, 5, "First");
    }),
  ),
);

it.effect("counts a queued reply where it shows once started, after a later steer", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const sub = yield* subThread("agent");
      const changed = changedIn(subThreads, sub.firstId);

      const third = yield* replyThrough(sub, changed, calls, { from: 1, to: 4 }, [1, 3]);
      yield* sub.queue(5);
      yield* changed(yield* sub.reply(6));
      // Reply 6 shows as user message 5, and reply 5 as user message 6.
      yield* changed(yield* sub.start(5));
      yield* summarizeAt(calls, 5, third);
    }),
  ),
);

it.effect("starts no run for a covered reply that is delivered again in a later turn", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sub = yield* subThread("agent");
      const changed = changedIn(subThreads, sub.firstId);

      const third = yield* replyThrough(sub, changed, calls, { from: 1, to: 3 }, [1, 3]);
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET ordinal = (SELECT MAX(ordinal) + 1 FROM orchestration_v2_projection_turn_items)
        WHERE turn_item_id = ${`item:${sub.replyId(3)}`}`;
      yield* changed(sub.current());
      yield* replyThrough(sub, changed, calls, { from: 4, to: 6 }, [6], third);
    }),
  ),
);

it.effect("drops a summary of a reply whose text an edit changed during the model call", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const snapshots = yield* collect(subThreads, 3);
      const sub = yield* subThread("agent");
      const changed = changedIn(subThreads, sub.firstId);

      yield* changed(yield* sub.reply(1));
      yield* Deferred.succeed((yield* nextRun(calls, 1)).answer, "First");
      yield* changed(yield* sub.reply(2));
      yield* changed(yield* sub.reply(3));
      const stale = yield* nextRun(calls, 3, "First");
      // A declined steer goes back to the queue under its id, where the user edits it.
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET payload_json = json_set(payload_json, '$.text', 'reply 3, edited.')
        WHERE turn_item_id = ${`item:${sub.replyId(3)}`}`;
      yield* Deferred.succeed(stale.answer, "Stale");
      yield* changed(sub.current());
      yield* summarizeAt(calls, 3, "First");

      assert.deepEqual(
        (yield* snapshots).map((snapshot) => snapshot[0]?.summary),
        [undefined, "First", "Summary 3"],
      );
    }),
  ),
);

it.effect("keeps a failed run's reply tried across a restart", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const sub = yield* subThread("agent");

      yield* changedIn(subThreads, sub.firstId)(yield* sub.reply(1));
      yield* Deferred.succeed((yield* nextRun(calls, 1)).answer, "First");
      yield* changedIn(subThreads, sub.firstId)(yield* sub.reply(2));
      yield* changedIn(subThreads, sub.firstId)(yield* sub.reply(3));
      yield* Deferred.fail((yield* nextRun(calls, 3, "First")).answer, failure);

      const restarted = Context.get(
        yield* Layer.build(Layer.fresh(SubThreads.layerFromServices)),
        SubThreads.SubThreads,
      );
      const changed = changedIn(restarted, sub.firstId);
      yield* changed(sub.current());
      yield* changed(yield* sub.reply(4));
      yield* summarizeAt(calls, 4, "First");
    }),
  ),
);

it.effect("labels a sub-thread that an agent's answer opens under the user's message", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const sub = yield* subThread("user");
      const changed = changedIn(subThreads, sub.firstId);
      const opening: VisibleCore = {
        id: "",
        from: "agent",
        text: "Late answer.",
        first: sub.firstId,
        reply: true,
      };

      yield* changed([...sub.current(), opening]);
      const opened = yield* Queue.take(calls);
      assert.strictEqual(opened.input.message, "USER:\nRoot.\n\nASSISTANT:\nLate answer.");
      yield* Deferred.succeed(opened.answer, "Opened");
      // An answer to a labeled sub-thread starts no run, so the next one is at user message 3.
      yield* changed([...sub.current(), opening]);
      yield* replyThrough(sub, changed, calls, { from: 1, to: 2 }, [2], "Opened");
    }),
  ),
);

it.effect("counts no reply that a fork inherited from its parent", () =>
  withSubThreads((subThreads, calls) =>
    Effect.gen(function* () {
      const sub = yield* subThread("agent");
      // A fork reads its parent's messages under the parent's thread id.
      yield* storeUserMessage({ id: "inherited", first: sub.firstId, threadId: otherId });
      yield* replyThrough(
        sub,
        changedIn(subThreads, sub.firstId),
        calls,
        { from: 1, to: 3 },
        [1, 3],
      );
    }),
  ),
);

it.effect.each([
  { from: "a summary at user message 3", stored: 3, covered: true, next: 6 },
  { from: "a summary stored before counts were kept", stored: 6, covered: false, next: 7 },
])("summarizes no user message again after a restart, from $from", ({ stored, covered, next }) =>
  withSubThreads((_subThreads, calls) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sub = yield* subThread("agent");
      yield* sql`INSERT INTO fork_thread_sub_thread (thread_id, first_id, read_at, summary)
          VALUES (${threadId}, ${sub.firstId}, NULL, 'Before')`;
      yield* replyThrough(sub, () => Effect.void, calls, { from: 1, to: stored }, []);
      if (covered) {
        yield* sql`INSERT INTO fork_thread_sub_thread_covered (thread_id, first_id, ordinal,
            turn_item_id)
            SELECT thread_id, ${sub.firstId}, ordinal, turn_item_id
            FROM orchestration_v2_projection_turn_items
            WHERE turn_item_id = ${`item:${sub.replyId(stored)}`}`;
      }

      const restarted = Context.get(
        yield* Layer.build(Layer.fresh(SubThreads.layerFromServices)),
        SubThreads.SubThreads,
      );
      const changed = changedIn(restarted, sub.firstId);
      const summary = yield* replyThrough(
        sub,
        changed,
        calls,
        { from: stored + 1, to: next },
        [next],
        "Before",
      );
      // A turn start may wrap the same message again.
      yield* changed(sub.current());
      yield* replyThrough(sub, changed, calls, { from: next + 1, to: 10 }, [10], summary);
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
        yield* sql`INSERT INTO fork_thread_sub_thread_covered (thread_id, first_id, ordinal,
          turn_item_id)
          VALUES (${id}, 'm1', 0, 'item:u1')`;
      }

      const restarted = Context.get(
        yield* Layer.build(Layer.fresh(SubThreads.layerFromServices)),
        SubThreads.SubThreads,
      );
      assert.deepEqual(yield* current(restarted, threadId), [
        { firstId: "m1", readAt, summary: null },
      ]);
      assert.deepEqual(yield* current(restarted, otherId), []);
      assert.deepEqual(yield* sql`SELECT thread_id FROM fork_thread_sub_thread_covered`, [
        { thread_id: threadId },
      ]);
    }),
  ),
);
