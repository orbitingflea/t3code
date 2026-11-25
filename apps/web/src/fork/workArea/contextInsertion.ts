import type { ComposerContextInsertionHandler } from "~/composerDraftStore";

/**
 * Active context-insertion handler per composer draft key, read by the draft store.
 * When several views share a draft, tracks the last-focused composer (else the last-mounted one).
 */
export const contextInsertionHandlers = new Map<string, ComposerContextInsertionHandler>();

// Two views of one chat mount two composers of one draft; each inserts at its own caret.
const mountedByKey = new Map<string, ComposerContextInsertionHandler[]>();
const focusedAt = new WeakMap<ComposerContextInsertionHandler, number>();
let focusCount = 0;

// The composer focused last; among those never focused, the one mounted last.
function choose(key: string): void {
  let chosen: ComposerContextInsertionHandler | undefined;
  for (const handler of mountedByKey.get(key) ?? []) {
    if (chosen === undefined || (focusedAt.get(handler) ?? 0) >= (focusedAt.get(chosen) ?? 0)) {
      chosen = handler;
    }
  }
  if (chosen === undefined) contextInsertionHandlers.delete(key);
  else contextInsertionHandlers.set(key, chosen);
}

/**
 * Registers a mounted composer's insertion `handler` for `key` and selects it if none has higher
 * focus priority. Returns a cleanup that removes only this handler and falls back to the next.
 */
export function mountContextInsertion(
  key: string,
  handler: ComposerContextInsertionHandler,
): () => void {
  mountedByKey.set(key, [...(mountedByKey.get(key) ?? []), handler]);
  choose(key);
  return () => {
    const rest = (mountedByKey.get(key) ?? []).filter((other) => other !== handler);
    if (rest.length > 0) mountedByKey.set(key, rest);
    else mountedByKey.delete(key);
    choose(key);
  };
}

/** Marks `handler` as the most recently focused composer for every draft key it is mounted on. */
export function focusContextInsertion(handler: ComposerContextInsertionHandler): void {
  focusedAt.set(handler, (focusCount += 1));
  for (const [key, mounted] of mountedByKey) {
    if (mounted.includes(handler)) choose(key);
  }
}
