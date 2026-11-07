import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { MessageId, ThreadId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { NORMAL_DISPLAY_MODE, resolveDisplayMode } from "@t3tools/shared/displayModes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../../serverSettings.ts";

export interface DisplayModeCompactionNoteShape {
  /**
   * The note that tells a thread's agent its display mode after a compaction of its conversation, or
   * `undefined` for a thread that never had a note and is Normal. It only reads, and it logs a failure
   * and returns `undefined`.
   */
  readonly noteAfterCompaction: (threadId: ThreadId) => Effect.Effect<string | undefined>;
}

export class DisplayModeCompactionNote extends Context.Service<
  DisplayModeCompactionNote,
  DisplayModeCompactionNoteShape
>()("t3/fork/displayModeWrap/DisplayModeCompactionNote") {}

/** The provided note service, or `undefined` in a runtime without one, such as an adapter test. */
export const providedCompactionNote = Effect.serviceOption(DisplayModeCompactionNote).pipe(
  Effect.map(Option.getOrUndefined),
);

/**
 * The mode that the thread's current agent was last told, or `unknown`. A thread with no row never
 * had a note sent, so no conversation of it holds one. Told nothing counts as told Normal.
 */
export const createToldTable = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`CREATE TABLE IF NOT EXISTS fork_display_mode_told (
    thread_id TEXT PRIMARY KEY,
    mode_id TEXT NOT NULL
  )`,
).pipe(Effect.orDie);

export const layer: Layer.Layer<
  DisplayModeCompactionNote,
  never,
  SqlClient.SqlClient | ServerSettings.ServerSettingsService
> = Layer.effect(
  DisplayModeCompactionNote,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    yield* createToldTable;

    const noteAfterCompaction: DisplayModeCompactionNoteShape["noteAfterCompaction"] = Effect.fn(
      "DisplayModeCompactionNote.noteAfterCompaction",
    )(function* (threadId) {
      return yield* Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const mode = resolveDisplayMode(settings.threadDisplayModes[threadId]);
        const told = yield* sql`SELECT 1 FROM fork_display_mode_told WHERE thread_id = ${threadId}`;
        return told.length === 0 && mode === NORMAL_DISPLAY_MODE ? undefined : mode.stateNotice;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Display mode note after compaction skipped", { threadId, cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      );
    });

    return DisplayModeCompactionNote.of({ noteAfterCompaction });
  }),
);

/**
 * Claude Code hooks for the thread's display mode notes. After each compaction they add the thread's
 * note to the main conversation; a subagent's compaction gets nothing, since the note is about the
 * user's screen. The prompt of a slash command gets its turn's `commandNote`, which counts as told only
 * then: a command that Claude runs locally never reaches the hook and leaves the note owed.
 */
export const claudeDisplayModeHooks = (input: {
  readonly notes: DisplayModeCompactionNoteShape | undefined;
  readonly threadId: ThreadId;
  readonly activeTurn: Effect.Effect<ProviderAdapter.ProviderAdapterV2TurnInput | undefined>;
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>;
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
  const { notes, threadId, activeTurn, runPromise } = input;
  return notes === undefined
    ? {}
    : {
        UserPromptSubmit: [
          {
            hooks: [
              async (hookInput) => {
                if (
                  hookInput.hook_event_name !== "UserPromptSubmit" ||
                  hookInput.source === "system"
                )
                  return {};
                const turn = await runPromise(activeTurn);
                const note = turn?.commandNote;
                if (note === undefined || hookInput.prompt.trim() !== turn?.message.text.trim())
                  return {};
                await runPromise(note.delivered);
                return {
                  hookSpecificOutput: {
                    hookEventName: "UserPromptSubmit",
                    additionalContext: note.text,
                  },
                };
              },
            ],
          },
        ],
        SessionStart: [
          {
            matcher: "compact",
            hooks: [
              async (input) => {
                if (input.agent_id !== undefined) return {};
                const note = await runPromise(notes.noteAfterCompaction(threadId));
                return note === undefined
                  ? {}
                  : {
                      hookSpecificOutput: {
                        hookEventName: "SessionStart",
                        additionalContext: note,
                      },
                    };
              },
            ],
          },
        ],
      };
};

/** The developer message for Codex's `thread/inject_items` after a compaction of a T3 thread's conversation. */
export const codexCompactionNoteItems = Effect.fn("DisplayModeCompactionNote.codexItems")(
  function* (
    notes: DisplayModeCompactionNoteShape | undefined,
    threadId: ThreadId | null | undefined,
  ) {
    const note =
      notes === undefined || threadId == null
        ? undefined
        : yield* notes.noteAfterCompaction(threadId);
    return note === undefined
      ? []
      : [{ type: "message", role: "developer", content: [{ type: "input_text", text: note }] }];
  },
);

/**
 * `params` with a slash command's note added to that one `turn/start`, under a key unique to the
 * message, so the entry is new to Codex each time.
 */
export const withCodexCommandNote = <P extends { readonly additionalContext?: object | null }>(
  params: P,
  messageId: MessageId,
  note: ProviderAdapter.ProviderAdapterV2TurnInput["commandNote"],
): P =>
  note === undefined
    ? params
    : {
        ...params,
        additionalContext: {
          ...params.additionalContext,
          [`t3_display_mode_${messageId.replace(/[^\w.-]/g, "_")}`]: {
            kind: "application",
            value: note.text,
          },
        },
      };
