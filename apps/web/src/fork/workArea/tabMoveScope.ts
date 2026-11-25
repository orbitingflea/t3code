import type { ScopedThreadRef } from "@t3tools/contracts";

// A leaf module, so `workAreaView` can capture a move without importing the history code.
type TabMoveHandler = (owner: ScopedThreadRef) => (() => void) | null;

let handler: TabMoveHandler | null = null;
let active: ScopedThreadRef | null = null;

/** Installs the single handler that observes each user tab move. Call once at startup. */
export function setTabMoveHandler(next: TabMoveHandler): void {
  handler = next;
}

/**
 * Runs `run` as a user tab move in `owner`'s work area.
 * Nested calls join the active outer move.
 */
export function userTabMove<T>(owner: ScopedThreadRef, run: () => T): T {
  if (handler === null || active !== null) return run();
  const end = handler(owner);
  if (end === null) return run();
  active = owner;
  try {
    return run();
  } finally {
    active = null;
    end();
  }
}

/**
 * Captures the active user tab move so an async step can continue it later.
 * Returns a plain runner when no move is active.
 */
export function captureTabMove(): <T>(run: () => T) => T {
  const owner = active;
  return owner === null ? (run) => run() : (run) => userTabMove(owner, run);
}
