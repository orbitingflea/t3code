// @effect-diagnostics globalDate:off - ServerBrowser calls these from Playwright callbacks outside the Effect runtime.
import * as Effect from "effect/Effect";

// Every change of a server preview tab's controller is logged with who and why, and a viewer
// that does not hold control is told who does, so a lock can be traced to its holder.

/** Why the controller of a server preview tab changed. */
export type ControlChangeReason = "attach" | "take" | "release" | "disconnect" | "tabClosed";

export interface ControlChange {
  /** Viewer ids; null means no viewer holds control. */
  readonly from: string | null;
  readonly to: string | null;
  readonly reason: ControlChangeReason;
}

/** Who holds control, as a viewer that does not hold it sees it. */
export interface ControlHolder {
  readonly viewer: string;
  /** Epoch ms when that viewer began to connect. */
  readonly attachedAt: number | null;
  /** False while its connect has not finished: no stream to it has opened. */
  readonly connected: boolean;
}

const viewers = new Map<string, { readonly attachedAt: number; connected: boolean }>();

export const viewerAttaching = (viewerId: string) => {
  viewers.set(viewerId, { attachedAt: Date.now(), connected: false });
};

export const viewerConnected = (viewerId: string) => {
  const record = viewers.get(viewerId);
  if (record) record.connected = true;
};

export const viewerGone = (viewerId: string) => {
  viewers.delete(viewerId);
};

const shortId = (viewerId: string) => viewerId.slice(0, 8);

const holder = (viewerId: string): ControlHolder => {
  const record = viewers.get(viewerId);
  return {
    viewer: shortId(viewerId),
    attachedAt: record?.attachedAt ?? null,
    connected: record?.connected ?? false,
  };
};

/** Extra fields of a control message for one viewer. */
export const controlFields = (viewerId: string, controller: string | null) => ({
  viewer: shortId(viewerId),
  holder: controller !== null && controller !== viewerId ? holder(controller) : null,
});

const describe = (viewerId: string | null) => {
  if (viewerId === null) return null;
  const { attachedAt, ...rest } = holder(viewerId);
  return { ...rest, attachedAt: attachedAt === null ? null : new Date(attachedAt).toISOString() };
};

/** The log entry is built now, while the viewers it names are still known. */
export const logControlChange = (
  tab: { readonly threadId: string; readonly tabId: string; readonly agentId: string | null },
  change: ControlChange,
): Effect.Effect<void> => {
  if (change.from === change.to) return Effect.void;
  const entry = {
    threadId: tab.threadId,
    tabId: tab.tabId,
    agentId: tab.agentId,
    reason: change.reason,
    from: describe(change.from),
    to: describe(change.to),
  };
  return Effect.logInfo("server preview control changed", entry);
};
