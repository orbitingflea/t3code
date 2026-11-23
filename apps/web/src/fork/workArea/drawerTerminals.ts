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
import { resolveStorage } from "~/lib/storage";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";
import type { ThreadTerminalGroup } from "~/types";

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

// The drawer drew every group, so each becomes one tab, split as the drawer split it.
function openGroupTabs(threadRef: ScopedThreadRef, groups: ReadonlyArray<ThreadTerminalGroup>) {
  const store = useRightPanelStore.getState();
  for (const group of groups) {
    const held = tabTerminalIds(recordOf(threadRef).surfaces);
    const [first, ...rest] = group.terminalIds.filter((id) => !held.includes(id));
    if (first === undefined) continue;
    const tab = `terminal:${first}`;
    store.openTerminal(threadRef, first);
    for (const id of rest) store.splitTerminal(threadRef, tab, id, group.splitDirection);
    store.activateTerminal(threadRef, tab, first);
  }
}

// Writes to the PTY's own thread record: a host's record would attach the host's shell.
const inOwnRecord = (threadRef: ScopedThreadRef, show: () => void) =>
  panelHostedElsewhere(threadRef)
    ? runWithOpenOrigin({ record: threadRef, guest: threadRef }, show)
    : show();

// A drawer saved open waits for its thread's first session list, as the drawer did, so a member
// closed on another client stays closed. The wait outlives a reload; the store keeps its groups.
const AWAITING_KEY = "t3code:fork:drawers-awaiting-tabs:v1";
const awaitingStorage = resolveStorage(
  typeof window === "undefined" ? undefined : window.localStorage,
);

function loadAwaiting(): ReadonlySet<string> {
  const raw = awaitingStorage.getItem(AWAITING_KEY);
  try {
    const keys: unknown = typeof raw === "string" ? JSON.parse(raw) : [];
    return new Set(Array.isArray(keys) ? keys.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

let awaiting = loadAwaiting();

function setAwaiting(next: ReadonlySet<string>) {
  awaiting = next;
  awaitingStorage.setItem(AWAITING_KEY, JSON.stringify([...next]));
}

function openSavedDrawer(threadRef: ScopedThreadRef, listed: ReadonlyArray<string>): boolean {
  const threadKey = scopedThreadKey(threadRef);
  if (!awaiting.has(threadKey)) return false;
  setAwaiting(new Set([...awaiting].filter((key) => key !== threadKey)));
  const saved = selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    threadRef,
  );
  const groups = saved.terminalGroups.map((group) => ({
    ...group,
    terminalIds: group.terminalIds.filter((id) => listed.includes(id)),
  }));
  const members = groups.flatMap((group) => group.terminalIds);
  const active = members.includes(saved.activeTerminalId) ? saved.activeTerminalId : members[0];
  if (active === undefined) return false;
  inOwnRecord(threadRef, () => {
    openGroupTabs(threadRef, groups);
    showTerminalTab(threadRef, active);
  });
  return true;
}

// A drawer saved open opens all its groups; a later request opens only its terminal.
function showDrawerRequests(next: DrawerStates, previous?: DrawerStates) {
  for (const [threadKey, state] of Object.entries(next)) {
    if (previous?.[threadKey] === state || !state.terminalOpen) continue;
    const threadRef = parseScopedThreadKey(threadKey);
    if (threadRef === null) continue;
    if (previous === undefined) setAwaiting(new Set([...awaiting, threadKey]));
    else inOwnRecord(threadRef, () => showTerminalTab(threadRef, state.activeTerminalId));
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
  const surfaces = openSavedDrawer(threadRef, input.sessionIds)
    ? recordOf(threadRef).surfaces
    : input.surfaces;
  const { adopt, seen } = adoptedTerminals({
    sessionIds: input.sessionIds,
    tabIds: tabTerminalIds(surfaces),
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
