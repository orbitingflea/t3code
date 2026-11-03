// @effect-diagnostics globalDate:off - ServerBrowser calls these from Playwright callbacks outside the Effect runtime.
import * as Effect from "effect/Effect";

import { SessionControl } from "../preview/SessionControl.ts";

// Every change of a server preview tab's controller is logged with who and why, and a viewer
// that does not hold control is told who does, so a lock can be traced to its holder.

/** Why the controller of a server preview tab changed. */
type ControlChangeReason = "attach" | "take" | "release" | "disconnect" | "tabClosed";

interface ControlChange {
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

let nextReason: ControlChangeReason | null = null;

/** Names why `run` changes the controller, for the change it makes before its first await. */
export const because = <A>(reason: ControlChangeReason, run: () => A): A => {
  nextReason = reason;
  try {
    return run();
  } finally {
    nextReason = null;
  }
};

/** Logs each change of controller. Each method below changes it before its first await. */
export class TracedSessionControl extends SessionControl {
  private readonly tab: { readonly threadId: string; readonly tabId: string };
  private readonly runLog: (log: Effect.Effect<void>) => void;

  constructor(
    tab: {
      readonly threadId: string;
      readonly tabId: string;
      readonly automationOwner?: string | undefined;
    },
    runLog: (log: Effect.Effect<void>) => void,
    onGenerationChange?: () => void,
  ) {
    super(tab.automationOwner ?? null, onGenerationChange);
    this.tab = { threadId: tab.threadId, tabId: tab.tabId };
    this.runLog = runLog;
  }

  private traced<A>(reason: ControlChangeReason, run: () => Promise<A>): Promise<A> {
    const from = this.controller;
    const named = nextReason ?? reason;
    const result = because(named, run);
    const tab = { ...this.tab, agentId: this.agentId };
    this.runLog(logControlChange(tab, { from, to: this.controller, reason: named }));
    return result;
  }

  override take(viewerId: string) {
    return this.traced("take", () => super.take(viewerId));
  }

  override release(viewerId: string, afterDrain?: () => Promise<void>) {
    return this.traced("release", () => super.release(viewerId, afterDrain));
  }

  // Disconnect releases through release, which logs it under this reason.
  override disconnect(viewerId: string, afterDrain?: () => Promise<void>) {
    return because("disconnect", () => super.disconnect(viewerId, afterDrain));
  }

  override close() {
    return this.traced("tabClosed", () => super.close());
  }
}
