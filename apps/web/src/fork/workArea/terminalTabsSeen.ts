import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

// Kept free of store imports: the upstream close hook reaches it, and its tests mock those modules.
const seenByThread = new Map<string, ReadonlySet<string>>();

export const seenTerminals = (threadRef: ScopedThreadRef): ReadonlySet<string> =>
  seenByThread.get(scopedThreadKey(threadRef)) ?? new Set();

export function setSeenTerminals(threadRef: ScopedThreadRef, seen: ReadonlySet<string>): void {
  seenByThread.set(scopedThreadKey(threadRef), seen);
}

// Any close, whatever the grant, keeps its tab from coming back while the page lives; a viewer who
// cannot stop a shell sees it again after a reload.
export function dismissTerminalTabs(
  threadRef: ScopedThreadRef,
  terminalIds: ReadonlyArray<string>,
): void {
  setSeenTerminals(threadRef, new Set([...seenTerminals(threadRef), ...terminalIds]));
}
