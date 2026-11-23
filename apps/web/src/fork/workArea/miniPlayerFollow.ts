// rightPanelStore.ts starts this after its store exists. The mini player store import stays first,
// so it is evaluated before the right panel store when this module is reached first.
import {
  type PreviewMiniPlayerSource,
  type PreviewMiniPlayerState,
  previewMiniPlayerSourceKey,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthPreviewOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  rightPanelHostRef,
  selectThreadRightPanelState,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { subscribeAtomChanges } from "~/rpc/atomRegistry";
import { environmentSession, readEnvironmentScope } from "~/state/session";

import { paneHolding, resolveLayout, surfaceTabId, type TabId } from "./workArea.logic";
import { keptFloat } from "./workAreaFloat.logic";
import { primaryChatRect } from "./workAreaGeometry.logic";
import { currentWorkAreaView, onWorkAreaViewChange } from "./workAreaView";

// ChatView draws a browser mini player only with the preview operate grant.
export const miniPlayerDraws = (threadRef: ScopedThreadRef, source: PreviewMiniPlayerSource) =>
  source.kind === "device" ||
  readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);

export function playingTab(threadKey: string): TabId | null {
  const source = usePreviewMiniPlayerStore.getState().byThreadKey[threadKey]?.source;
  const threadRef = parseScopedThreadKey(threadKey);
  return source === undefined || threadRef === null || !miniPlayerDraws(threadRef, source)
    ? null
    : surfaceTabId(previewMiniPlayerSourceKey(source));
}

const floatingIn = (record: ThreadRightPanelState) => resolveLayout(record).floating?.tab;

// Forced reveals of new browsers by thread key, held from `revealServerTabs` until
// `followPreviewSessions` adds their tabs right after.
const revealWhenAdded = new Map<string, ReadonlySet<string>>();

// True when no drawn primary Chat would show the mini player: the tab then reveals in a pane.
export function deferForcedReveal(threadRef: ScopedThreadRef, tabId: string): boolean {
  const record = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
  if (primaryChatRect(resolveLayout(record), currentWorkAreaView()) !== null) return false;
  const threadKey = scopedThreadKey(threadRef);
  revealWhenAdded.set(threadKey, new Set(revealWhenAdded.get(threadKey)).add(tabId));
  return true;
}

export function revealAddedBrowsers(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  const tabIds = revealWhenAdded.get(threadKey);
  if (tabIds === undefined) return;
  revealWhenAdded.delete(threadKey);
  const store = useRightPanelStore.getState();
  for (const surface of selectThreadRightPanelState(store.byThreadKey, threadRef).surfaces) {
    if (
      surface.kind === "preview" &&
      surface.resourceId !== null &&
      tabIds.has(surface.resourceId)
    ) {
      store.revealSurface(threadRef, surface.id);
    }
  }
}

// Defers via microtask so "Open in panel" can close the player and place the tab first.
function unfloatClosedMiniPlayers(
  next: { readonly byThreadKey: Record<string, PreviewMiniPlayerState> },
  previous: { readonly byThreadKey: Record<string, PreviewMiniPlayerState> },
): void {
  for (const [threadKey, entry] of Object.entries(previous.byThreadKey)) {
    if (next.byThreadKey[threadKey]?.source === entry.source) continue;
    const threadRef = parseScopedThreadKey(threadKey);
    if (threadRef === null) continue;
    const tab = surfaceTabId(previewMiniPlayerSourceKey(entry.source));
    queueMicrotask(() => {
      const host = rightPanelHostRef(threadRef);
      const record = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, host);
      if (floatingIn(record) !== tab) return;
      useRightPanelStore.getState().updateWorkArea(host, { type: "unfloat", tab });
    });
  }
}

// A floating tab placed again (such as by an agent's forced reveal) leaves its mini player.
function closeDockedMiniPlayers(
  next: { readonly byThreadKey: Record<string, ThreadRightPanelState> },
  previous: { readonly byThreadKey: Record<string, ThreadRightPanelState> },
): void {
  if (next.byThreadKey === previous.byThreadKey) return;
  const players = usePreviewMiniPlayerStore.getState();
  for (const [threadKey, entry] of Object.entries(players.byThreadKey)) {
    const threadRef = parseScopedThreadKey(threadKey);
    if (threadRef === null) continue;
    const host = rightPanelHostRef(threadRef);
    const before = selectThreadRightPanelState(previous.byThreadKey, host);
    const after = selectThreadRightPanelState(next.byThreadKey, host);
    if (before === after) continue;
    const tab = surfaceTabId(previewMiniPlayerSourceKey(entry.source));
    if (floatingIn(before) === tab && paneHolding(resolveLayout(after).root, tab)) {
      players.close(threadRef);
    }
  }
}

// A view that stops drawing the primary Chat, or a lost preview grant, writes no record, so the
// float rule runs here too: a tab floats only while a drawn Chat draws its playing mini player.
function unfloatStrandedTabs(): void {
  const view = currentWorkAreaView();
  for (const [threadKey, record] of Object.entries(useRightPanelStore.getState().byThreadKey)) {
    const layout = record.workArea;
    const threadRef = parseScopedThreadKey(threadKey);
    if (layout?.floating === undefined || threadRef === null) continue;
    if (keptFloat(layout, view) !== layout || playingTab(threadKey) !== layout.floating.tab) {
      useRightPanelStore
        .getState()
        .updateWorkArea(threadRef, { type: "unfloat", tab: layout.floating.tab });
    }
  }
}

// The preview grant lives in each environment's session, so the follower watches the session of
// every environment with a mini player and reruns the float rule when it changes.
const grantFollows = new Map<EnvironmentId, () => void>();
function followPreviewGrants(players: {
  readonly byThreadKey: Record<string, PreviewMiniPlayerState>;
}): void {
  const environments = new Set(
    Object.keys(players.byThreadKey).flatMap(
      (threadKey) => parseScopedThreadKey(threadKey)?.environmentId ?? [],
    ),
  );
  for (const [environmentId, stop] of grantFollows) {
    if (environments.has(environmentId)) continue;
    stop();
    grantFollows.delete(environmentId);
  }
  for (const environmentId of environments) {
    if (grantFollows.has(environmentId)) continue;
    const session = environmentSession.sessionStateAtom(environmentId);
    grantFollows.set(environmentId, subscribeAtomChanges(session, unfloatStrandedTabs));
  }
}

export function followMiniPlayers(): void {
  usePreviewMiniPlayerStore.subscribe(followPreviewGrants);
  usePreviewMiniPlayerStore.subscribe(unfloatClosedMiniPlayers);
  useRightPanelStore.subscribe(closeDockedMiniPlayers);
  onWorkAreaViewChange(unfloatStrandedTabs);
}
