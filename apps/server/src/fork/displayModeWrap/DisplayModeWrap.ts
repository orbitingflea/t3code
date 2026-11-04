import {
  type MessageId,
  type OrchestrationV2Actor,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  type DisplayEvent,
  displayEventFromTurnItem,
  isPersonMessage,
  resolveDisplayMode,
} from "@t3tools/shared/displayModes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import {
  buildBoundedThreadProjection,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "../../orchestration-v2/threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "../../orchestration-v2/WireProjection.ts";
import * as ServerSettings from "../../serverSettings.ts";

export interface DisplayModeWrapShape {
  /**
   * `message` starts a turn, or it steers a turn that is still running. The result is the
   * text that the agent gets. It is `text` unless the thread's display mode wraps it.
   */
  readonly wrapUserText: (input: {
    readonly threadId: ThreadId;
    readonly message: {
      readonly id: MessageId;
      readonly createdBy: OrchestrationV2Actor;
      readonly scheduledTaskId?: unknown;
      readonly senderThreadId?: unknown;
      readonly text: string;
    };
    readonly text: string;
  }) => Effect.Effect<string>;
}

export class DisplayModeWrap extends Context.Service<DisplayModeWrap, DisplayModeWrapShape>()(
  "t3/fork/displayModeWrap/DisplayModeWrap",
) {}

/**
 * Removes the stored mode of each deleted thread. A deleted thread keeps its projection row,
 * with `deleted_at` set.
 */
export const pruneDeletedThreadModes = Effect.fn("DisplayModeWrap.pruneDeletedThreadModes")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const threadIds = Object.keys((yield* serverSettings.getSettings).threadDisplayModes);
    if (threadIds.length === 0) return;
    const deleted = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE thread_id IN ${sql.in(threadIds)} AND deleted_at IS NOT NULL
    `;
    if (deleted.length === 0) return;
    yield* serverSettings.updateSettings({
      threadDisplayModes: Object.fromEntries(deleted.map((row) => [row.thread_id, null])),
    });
  },
);

export const layer: Layer.Layer<
  DisplayModeWrap,
  never,
  SqlClient.SqlClient | ServerSettings.ServerSettingsService | ProviderRegistry.ProviderRegistry
> = Layer.effect(
  DisplayModeWrap,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

    yield* serverSettings.ready.pipe(
      Effect.andThen(pruneDeletedThreadModes()),
      Effect.catchCause((cause) => Effect.logWarning("Display mode prune skipped", { cause })),
      Effect.forkScoped,
    );

    // Reads the same history window that the screen first loads, and ends the window at this message.
    // A forked thread's window includes the rows it inherits from its source, so those rows count too.
    const eventsBefore = Effect.fn("DisplayModeWrap.eventsBefore")(function* (
      threadId: ThreadId,
      messageId: MessageId,
    ) {
      const anchors = yield* sql<{ readonly turn_item_id: string }>`
        SELECT turn_item_id FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId} AND type = 'user_message'
          AND json_extract(payload_json, '$.messageId') = ${messageId}
        ORDER BY ordinal DESC LIMIT 1
      `;
      if (anchors[0] === undefined) return [];
      const anchorItemId = TurnItemId.make(anchors[0].turn_item_id);
      const { projection, snapshotSequence } = yield* projectionStore.getThreadSnapshotWindow(
        threadId,
        {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
          deferWork: true,
          anchorItemId,
          anchorThreadId: threadId,
        },
      );
      const rows = projection.visibleTurnItems;
      const end = rows.findIndex(
        (row) => row.sourceThreadId === threadId && row.sourceItemId === anchorItemId,
      );
      const events: DisplayEvent[] = [];
      // History folds a long run of tool work into one row, placed at the run's first item.
      // That folded row stands for all work up to `lastOrdinal`.
      // A sent message inside that range still has its own row after the folded row.
      // The loop adds the work event when the range ends, so work after the sent message counts.
      let openFold: { readonly threadId: ThreadId; readonly lastOrdinal: number } | null = null;
      for (const row of end === -1 ? rows : rows.slice(0, end)) {
        if (
          openFold !== null &&
          (row.sourceThreadId !== openFold.threadId || row.item.ordinal > openFold.lastOrdinal)
        ) {
          events.push({ type: "work" });
          openFold = null;
        }
        const event = displayEventFromTurnItem(row.item);
        if (event !== null) events.push(event);
        if (row.item.deferredWork !== undefined) {
          openFold = {
            threadId: row.sourceThreadId,
            lastOrdinal: row.item.deferredWork.lastOrdinal,
          };
        }
      }
      if (openFold !== null) events.push({ type: "work" });
      // The screen's first page (10 user turns and a byte budget) can leave out older history,
      // which may hold tool work. When the window has no sent message, that work may come after
      // the agent's last sent message, so the left-out part counts as work.
      const { hasMoreHistory } = buildBoundedThreadProjection({
        projection: projectThreadProjectionForWire(projection),
        snapshotSequence,
      });
      if (hasMoreHistory && !events.some((event) => event.type === "sent")) {
        events.unshift({ type: "work" });
      }
      return events;
    });

    // The provider reads a slash command only at the start of the text.
    // A `<t3-messages-mode>` block before the command would break the command.
    // The known commands are the ones that the composer offers for the thread's provider and folder.
    const isSlashCommand = Effect.fn("DisplayModeWrap.isSlashCommand")(function* (
      threadId: ThreadId,
      text: string,
    ) {
      const name = /^\/(\S+)/.exec(text.trimStart())?.[1];
      if (name === undefined) return false;
      const threads = yield* sql<{ readonly instance_id: string; readonly cwd: string | null }>`
        SELECT json_extract(t.payload_json, '$.modelSelection.instanceId') AS instance_id,
          COALESCE(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS cwd
        FROM orchestration_v2_projection_threads t
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.thread_id = ${threadId}
      `;
      const thread = threads[0];
      if (thread === undefined) return false;
      const provider = (yield* providerRegistry.getProviders).find(
        (candidate) => candidate.instanceId === thread.instance_id,
      );
      if (provider === undefined) return false;
      const commands =
        provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === thread.cwd)
          ?.slashCommands ?? provider.slashCommands;
      return commands.some((command) => command.name === name);
    });

    const wrapUserText: DisplayModeWrapShape["wrapUserText"] = Effect.fn(
      "DisplayModeWrap.wrapUserText",
    )(function* ({ threadId, message, text }) {
      if (!isPersonMessage(message)) return text;
      const settings = yield* serverSettings.getSettings.pipe(Effect.option);
      if (settings._tag === "None") return text;
      const wrap = resolveDisplayMode(settings.value.threadDisplayModes[threadId]).wrap;
      if (wrap === null) return text;
      return yield* isSlashCommand(threadId, message.text).pipe(
        Effect.flatMap((command) =>
          command
            ? Effect.succeed(text)
            : eventsBefore(threadId, message.id).pipe(Effect.map((events) => wrap(events, text))),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Display mode wrap skipped", {
            threadId,
            messageId: message.id,
            error,
          }).pipe(Effect.as(text)),
        ),
      );
    });

    return DisplayModeWrap.of({ wrapUserText });
  }),
).pipe(Layer.provide(ProjectionStore.layer));

/** Sends every message unchanged. Tests of the services that call the wrapper use this layer. */
export const layerUnchanged = Layer.succeed(DisplayModeWrap, {
  wrapUserText: Effect.fn("DisplayModeWrap.wrapUserTextUnchanged")(({ text }) =>
    Effect.succeed(text),
  ),
});
