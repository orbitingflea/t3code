import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { closingTerminalIds } from "~/components/terminal/closingTerminals";
import {
  type RightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";

import { panelHostedElsewhere } from "./chatFileOpener";
import { adoptedTerminals, reusableTabTerminal, tabTerminalIds } from "./drawerTerminals.logic";
import { seenTerminals, setSeenTerminals } from "./terminalTabsSeen";
import { runWithOpenOrigin, shownSurfaceOf } from "./workAreaView";

type DrawerStates = ReturnType<
  typeof useTerminalUiStateStore.getState
>["terminalUiStateByThreadKey"];

const recordOf = (threadRef: ScopedThreadRef) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

function showTerminalTab(threadRef: ScopedThreadRef, terminalId: string) {
  const store = useRightPanelStore.getState();
  const holder = recordOf(threadRef).surfaces.find(
    (surface) => surface.kind === "terminal" && surface.terminalIds.includes(terminalId),
  );
  if (holder === undefined) store.openTerminal(threadRef, terminalId);
  else {
    store.activateTerminal(threadRef, holder.id, terminalId);
    store.activateSurface(threadRef, holder.id);
  }
}

// Writes to the PTY's own thread record: a host's record would attach the host's shell.
const showInOwnRecord = (threadRef: ScopedThreadRef, terminalId: string) =>
  panelHostedElsewhere(threadRef)
    ? runWithOpenOrigin({ record: threadRef, guest: threadRef }, () =>
        showTerminalTab(threadRef, terminalId),
      )
    : showTerminalTab(threadRef, terminalId);

function showDrawerRequests(next: DrawerStates, previous?: DrawerStates) {
  for (const [threadKey, state] of Object.entries(next)) {
    if (previous?.[threadKey] === state || !state.terminalOpen) continue;
    const threadRef = parseScopedThreadKey(threadKey);
    if (threadRef === null) continue;
    showInOwnRecord(threadRef, state.activeTerminalId);
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, false);
  }
}

let following = false;

// Zustand runs subscribers inside `set`, so no render sees the drawer open.
export function followDrawerTerminals(): void {
  if (following) return;
  following = true;
  showDrawerRequests(useTerminalUiStateStore.getState().terminalUiStateByThreadKey);
  useTerminalUiStateStore.subscribe((next, previous) => {
    if (next.terminalUiStateByThreadKey === previous.terminalUiStateByThreadKey) return;
    showDrawerRequests(next.terminalUiStateByThreadKey, previous.terminalUiStateByThreadKey);
  });
}

export function reusableTerminalTab(
  threadRef: ScopedThreadRef,
  running: ReadonlyArray<string>,
): string | null {
  const record = recordOf(threadRef);
  const shown = shownSurfaceOf(record, "terminal");
  return reusableTabTerminal(
    record.surfaces,
    shown?.kind === "terminal" ? shown.activeTerminalId : null,
    running,
    closingTerminalIds(threadRef),
  );
}

// The shortcut context's `terminalOpen`: the drawer is never open here, a terminal tab is. A
// hosted thread's own record is drawn nowhere.
export const terminalTabShown = (threadRef: ScopedThreadRef | null): boolean =>
  threadRef !== null &&
  !panelHostedElsewhere(threadRef) &&
  shownSurfaceOf(recordOf(threadRef), "terminal") !== undefined;

// Tabs for the thread's listed sessions that never had one.
export function adoptServerTerminals(
  threadRef: ScopedThreadRef,
  input: {
    readonly sessionIds: ReadonlyArray<string>;
    readonly surfaces: ReadonlyArray<RightPanelSurface>;
    readonly suppressed: ReadonlyArray<string>;
  },
): void {
  const { adopt, seen } = adoptedTerminals({
    sessionIds: input.sessionIds,
    tabIds: tabTerminalIds(input.surfaces),
    seen: seenTerminals(threadRef),
    skipped: [...closingTerminalIds(threadRef), ...input.suppressed],
  });
  setSeenTerminals(threadRef, seen);
  for (const terminalId of adopt) {
    useRightPanelStore.getState().openTerminal(threadRef, terminalId, true);
  }
}

export function useAdoptServerTerminals(threadRef: ScopedThreadRef): void {
  const { environmentId, threadId } = threadRef;
  const threadKey = scopedThreadKey(threadRef);
  const sessions = useKnownTerminalSessions({ environmentId, threadId });
  const surfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  const suppressed = useTerminalUiStateStore(
    (state) => state.suppressedTerminalIdsByThreadKey[threadKey],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server's terminal session list is external
  useEffect(() => {
    if (sessions === null) return;
    adoptServerTerminals(scopeThreadRef(environmentId, threadId), {
      sessionIds: sessions
        .filter((session) => session.target.threadId === threadId)
        .map((session) => session.target.terminalId),
      surfaces,
      suppressed: suppressed ?? [],
    });
  }, [environmentId, threadId, sessions, surfaces, suppressed]);
}
