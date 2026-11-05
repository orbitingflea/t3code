import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "../baseSchemas.ts";
import type { OrchestrationV2IdleCompaction } from "../orchestrationV2.ts";

/**
 * The prefix of the message id of an idle-level compaction. Its wire marker stays
 * "beforeCacheExpires", because a server one build older fails a whole thread on a marker it does
 * not know, and a rollback must still open every thread.
 */
export const WHILE_IDLE_COMPACTION_ID_PREFIX = "idle-compact-while-idle:";

export type IdleCompactionLevel = OrchestrationV2IdleCompaction | "whileIdle";

/** The Compact chip reads its own constant, so these defaults do not move it. */
export const COMPACT_WHEN_IDLE_DEFAULTS = { cacheTokens: 200_000, tokens: 400_000, minutes: 15 };

export const COMPACT_WHEN_IDLE_MAX = { tokens: 9_999_999, minutes: 9_999 };

/**
 * A stored value as the server reads it: a whole number from 1 to `max` in plain digits with no
 * leading zeros, else null.
 */
export const parseCompactWhenIdleCount = (value: string, max: number) =>
  /^[1-9]\d*$/.test(value) && Number(value) <= max ? Number(value) : null;

// Any text decodes, because a failed decode makes the server use default settings until the file
// is fixed. The server keeps the default for any value `parseCompactWhenIdleCount` rejects.
const Count = TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("")));

/**
 * Not a new `idleCompaction` mode: shipped clients and older servers decode that field strictly,
 * so "Compact when idle" is "Before the cache expires" plus `compactWhenIdle`.
 */
export const CompactWhenIdleSettings = {
  compactWhenIdle: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  compactBeforeCacheExpiresTokens: Count,
  compactWhenIdleTokens: Count,
  compactWhenIdleMinutes: Count,
};

export const CompactWhenIdleSettingsPatch = {
  compactWhenIdle: Schema.optionalKey(Schema.Boolean),
  compactBeforeCacheExpiresTokens: Schema.optionalKey(TrimmedString),
  compactWhenIdleTokens: Schema.optionalKey(TrimmedString),
  compactWhenIdleMinutes: Schema.optionalKey(TrimmedString),
};
