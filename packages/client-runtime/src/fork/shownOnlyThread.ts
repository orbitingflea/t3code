import * as Effect from "effect/Effect";

import type * as Persistence from "../platform/persistence.ts";

const SHOWN_KEY_SUFFIX = "\u0000shown";

/**
 * The state key of a thread's view: its thread key, or for the view that holds only what a
 * display mode shows, the thread key with a suffix. Each view has its own state and resume entry.
 */
export const threadViewKey = (threadKey: string, shownOnly: boolean): string =>
  shownOnly ? `${threadKey}${SHOWN_KEY_SUFFIX}` : threadKey;

export function parseThreadViewKey(key: string): {
  readonly threadKey: string;
  readonly shownOnly: boolean;
} {
  return key.endsWith(SHOWN_KEY_SUFFIX)
    ? { threadKey: key.slice(0, -SHOWN_KEY_SUFFIX.length), shownOnly: true }
    : { threadKey: key, shownOnly: false };
}

/**
 * The cache a shown-only state uses. The saved thread snapshot is the Normal view's, so a shown
 * state neither loads it nor saves over it; removing a deleted thread still reaches the store.
 */
export const withoutThreadSnapshots = (
  store: Persistence.EnvironmentCacheStore["Service"],
): Persistence.EnvironmentCacheStore["Service"] => ({
  ...store,
  loadThread: () => Effect.succeedNone,
  saveThread: () => Effect.void,
});
