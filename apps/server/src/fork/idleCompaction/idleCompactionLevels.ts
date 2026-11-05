import {
  ClaudeSettings,
  COMPACT_WHEN_IDLE_DEFAULTS,
  COMPACT_WHEN_IDLE_MAX,
  compactIdleChoice,
  type IdleCompactionLevel,
  MessageId,
  type OrchestrationV2Run,
  parseCompactWhenIdleCount,
  type ProviderInstanceId,
  type RunId,
  type ServerSettings,
  type ThreadId,
  WHILE_IDLE_COMPACTION_ID_PREFIX,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * When an idle Claude thread compacts, at whichever level comes first: shortly before its prompt
 * cache expires, so the compaction reads a warm cache, or a set wait after the last message or
 * answer from a user or a bot, so it runs while no one waits for a reply. The idle level also runs
 * when the cache expiry is unknown or past, and right away when a run ends after its wait is over.
 */
export interface IdleCompactionLevels {
  readonly cacheMinTokens: number;
  readonly idle: { readonly afterMs: number; readonly minTokens: number } | null;
}

export const DEFAULT_IDLE_COMPACTION_LEVELS: IdleCompactionLevels = {
  cacheMinTokens: COMPACT_WHEN_IDLE_DEFAULTS.cacheTokens,
  idle: null,
};

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

/** For a thread whose idle compaction mode resolves to "Before the cache expires". */
export function resolveIdleCompactionLevels(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): IdleCompactionLevels {
  const instance = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  const override = decodeClaudeSettings(instance?.config ?? {}).pipe(
    Option.map((config) => config.idleCompaction),
    Option.getOrElse(() => "default" as const),
  );
  return {
    cacheMinTokens:
      parseCompactWhenIdleCount(
        settings.compactBeforeCacheExpiresTokens,
        COMPACT_WHEN_IDLE_MAX.tokens,
      ) ?? COMPACT_WHEN_IDLE_DEFAULTS.cacheTokens,
    idle:
      override === "default" && compactIdleChoice(settings) === "whenIdle"
        ? {
            afterMs:
              (parseCompactWhenIdleCount(
                settings.compactWhenIdleMinutes,
                COMPACT_WHEN_IDLE_MAX.minutes,
              ) ?? COMPACT_WHEN_IDLE_DEFAULTS.minutes) * 60_000,
            minTokens:
              parseCompactWhenIdleCount(
                settings.compactWhenIdleTokens,
                COMPACT_WHEN_IDLE_MAX.tokens,
              ) ?? COMPACT_WHEN_IDLE_DEFAULTS.tokens,
          }
        : null,
  };
}

/** The level with the earlier start, or null when neither applies. */
export function idleCompactionStart(
  levels: IdleCompactionLevels,
  thread: {
    readonly usedTokens: number;
    /** Null when no message or answer on the thread came from a user or a bot. */
    readonly lastUserInputMs: number | null;
    /** When the cache level would start; null when the cache expiry is unknown or past. */
    readonly beforeCacheExpiresMs: number | null;
  },
): {
  readonly startMs: number;
  readonly level: Exclude<IdleCompactionLevel, "onReturn">;
} | null {
  const cache =
    thread.usedTokens >= levels.cacheMinTokens && thread.beforeCacheExpiresMs !== null
      ? { startMs: thread.beforeCacheExpiresMs, level: "beforeCacheExpires" as const }
      : null;
  const idle =
    levels.idle !== null &&
    thread.usedTokens >= levels.idle.minTokens &&
    thread.lastUserInputMs !== null
      ? { startMs: thread.lastUserInputMs + levels.idle.afterMs, level: "whileIdle" as const }
      : null;
  if (cache === null || idle === null) return cache ?? idle;
  return idle.startMs < cache.startMs ? idle : cache;
}

/**
 * Compaction waits while a delegated task's result is on its way, because delivering the result
 * starts a run. That run checks again when it completes.
 */
export const idleCompactionHeld = (run: OrchestrationV2Run) =>
  run.delegatedCompletion?.delivery != null;

export const idleCompactionMessageId = (
  level: Exclude<IdleCompactionLevel, "onReturn">,
  threadId: ThreadId,
  runId: RunId,
) =>
  MessageId.make(
    `${level === "whileIdle" ? WHILE_IDLE_COMPACTION_ID_PREFIX : "idle-compact:"}${threadId}:${runId}`,
  );
