import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ThreadDashboard from "./ThreadDashboard.ts";

const threadId = ThreadId.make("thread:dashboard");
const otherId = ThreadId.make("thread:dashboard:other");

const layer = ThreadDashboard.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const slotsOf = (dashboard: ThreadDashboard.ThreadDashboardShape, id: ThreadId) =>
  dashboard.read(id).pipe(Effect.map((snapshot) => snapshot.slots));

it.effect("gives a new thread all six slots, empty and never written, in page order", () =>
  Effect.gen(function* () {
    const dashboard = yield* ThreadDashboard.ThreadDashboard;
    assert.deepEqual(yield* dashboard.read(threadId), {
      threadId,
      slots: (["decide", "waiting", "working", "autoreview", "humanreview", "merged"] as const).map(
        (slot) => ({ slot, text: "", updatedAt: null, seenText: null }),
      ),
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("replaces one slot of one thread and leaves the rest", () =>
  Effect.gen(function* () {
    const dashboard = yield* ThreadDashboard.ThreadDashboard;
    yield* dashboard.set(threadId, "working", "", "First");
    yield* dashboard.set(threadId, "working", "First", "Second");
    const slots = yield* slotsOf(dashboard, threadId);
    assert.deepEqual(
      slots.map((slot) => slot.text),
      ["", "", "Second", "", "", ""],
    );
    assert.strictEqual(slots[2]?.updatedAt, "1970-01-01T00:00:00.000Z");
    assert.deepEqual(
      (yield* slotsOf(dashboard, otherId)).map((slot) => slot.text),
      ["", "", "", "", "", ""],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a write whose old text no longer matches the slot, and keeps the slot", () =>
  Effect.gen(function* () {
    const dashboard = yield* ThreadDashboard.ThreadDashboard;
    yield* dashboard.set(threadId, "working", "", "Port the tests to the new API");
    const refused = yield* dashboard
      .set(threadId, "working", "Something else entirely", "Overwrite")
      .pipe(Effect.flip);
    assert.strictEqual(refused._tag, "DashboardTextMismatch");
    assert.strictEqual(refused.current, "Port the tests to the new API");
    const stillEmpty = yield* dashboard.set(threadId, "merged", "PR 12", "PR 13").pipe(Effect.flip);
    assert.strictEqual(stillEmpty.current, "");
    assert.deepEqual(
      (yield* slotsOf(dashboard, threadId)).map((slot) => slot.text),
      ["", "", "Port the tests to the new API", "", "", ""],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("marks a slot read only while it still holds the text the user read", () =>
  Effect.gen(function* () {
    const dashboard = yield* ThreadDashboard.ThreadDashboard;
    yield* dashboard.markSeen({ threadId, slot: "decide", text: "" });
    assert.strictEqual((yield* slotsOf(dashboard, threadId))[0]?.seenText, null);

    yield* dashboard.set(threadId, "decide", "", "Pick A or B");
    yield* dashboard.markSeen({ threadId, slot: "decide", text: "An older text" });
    assert.strictEqual((yield* slotsOf(dashboard, threadId))[0]?.seenText, null);

    yield* dashboard.markSeen({ threadId, slot: "decide", text: "Pick A or B" });
    yield* dashboard.set(threadId, "decide", "Pick A or B", "Pick A, B or C");
    const decide = (yield* slotsOf(dashboard, threadId))[0];
    assert.strictEqual(decide?.text, "Pick A, B or C");
    assert.strictEqual(decide?.seenText, "Pick A or B");
  }).pipe(Effect.provide(layer)),
);

it.effect("streams the current snapshot and then every write in order", () =>
  Effect.gen(function* () {
    const dashboard = yield* ThreadDashboard.ThreadDashboard;
    yield* dashboard.set(threadId, "waiting", "", "Before");
    const subscribed = yield* Deferred.make<void>();
    const collected = yield* dashboard.changes(threadId).pipe(
      Stream.tap(() => Deferred.succeed(subscribed, undefined)),
      Stream.take(4),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(subscribed);
    yield* Effect.all(
      [
        dashboard.set(threadId, "waiting", "Before", "A"),
        dashboard.set(threadId, "waiting", "A", "B"),
        dashboard.markSeen({ threadId, slot: "waiting", text: "B" }),
      ],
      { concurrency: 1 },
    );
    const snapshots = Array.from(yield* Fiber.join(collected));
    assert.deepEqual(
      snapshots.map((snapshot) => [snapshot.slots[1]?.text, snapshot.slots[1]?.seenText]),
      [
        ["Before", null],
        ["A", null],
        ["B", null],
        ["B", "B"],
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("keeps each write when two writes to one thread race", () =>
  Effect.gen(function* () {
    const dashboard = yield* ThreadDashboard.ThreadDashboard;
    yield* Effect.all(
      [dashboard.set(threadId, "working", "", "W"), dashboard.set(threadId, "merged", "", "M")],
      { concurrency: "unbounded" },
    );
    const texts = (yield* slotsOf(dashboard, threadId)).map((slot) => slot.text);
    assert.deepEqual(texts, ["", "", "W", "", "", "M"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps a thread's Dashboard across restarts and drops a deleted thread's", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const dashboard = yield* ThreadDashboard.ThreadDashboard;
    for (const [id, deletedAt] of [
      [threadId, null],
      [otherId, "2026-01-02T00:00:00.000Z"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
        default_provider, runtime_mode, interaction_mode, created_at, updated_at, deleted_at,
        payload_json)
        VALUES (${id}, 'project', 'Thread', 'codex', 'full-access', 'default',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${deletedAt}, '{}')`;
      yield* dashboard.set(id, "merged", "", `Merged in ${id}`);
    }

    const restarted = Context.get(
      yield* Layer.build(Layer.fresh(ThreadDashboard.layer)),
      ThreadDashboard.ThreadDashboard,
    );
    assert.strictEqual((yield* slotsOf(restarted, threadId))[5]?.text, `Merged in ${threadId}`);
    assert.strictEqual((yield* slotsOf(restarted, otherId))[5]?.text, "");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
