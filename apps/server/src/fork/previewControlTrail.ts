import * as DateTime from "effect/DateTime";
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
}

const attachTimes = new Map<string, number>();

export const viewerAttaching = (viewerId: string, at: number) => {
  attachTimes.set(viewerId, at);
};

export const viewerGone = (viewerId: string) => {
  attachTimes.delete(viewerId);
};

const shortId = (viewerId: string) => viewerId.slice(0, 8);

const holder = (viewerId: string): ControlHolder => ({
  viewer: shortId(viewerId),
  attachedAt: attachTimes.get(viewerId) ?? null,
});

/** Extra fields of a control message for one viewer. */
export const controlFields = (viewerId: string, controller: string | null) => ({
  viewer: shortId(viewerId),
  holder: controller !== null && controller !== viewerId ? holder(controller) : null,
});

const describe = (viewerId: string | null) => {
  if (viewerId === null) return null;
  const { viewer, attachedAt } = holder(viewerId);
  return {
    viewer,
    attachedAt: attachedAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(attachedAt)),
  };
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
    const result = run();
    const tab = { ...this.tab, agentId: this.agentId };
    this.runLog(logControlChange(tab, { from, to: this.controller, reason }));
    return result;
  }

  /** Takes control for a viewer that just finished connecting. */
  attach(viewerId: string) {
    return this.traced("attach", () => super.take(viewerId));
  }

  override take(viewerId: string) {
    return this.traced("take", () => super.take(viewerId));
  }

  override release(viewerId: string, afterDrain?: () => Promise<void>) {
    return this.traced("release", () => super.release(viewerId, afterDrain));
  }

  // A closed tab has no controller, so this matches SessionControl.disconnect.
  override async disconnect(viewerId: string, afterDrain?: () => Promise<void>) {
    if (this.controller === viewerId)
      await this.traced("disconnect", () => super.release(viewerId, afterDrain));
  }

  override close() {
    return this.traced("tabClosed", () => super.close());
  }
}
