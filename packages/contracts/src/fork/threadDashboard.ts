import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { IsoDateTime, ThreadId } from "../baseSchemas.ts";

/** The Dashboard's slots in page order. */
export const DASHBOARD_SLOT_IDS = [
  "decide",
  "waiting",
  "working",
  "autoreview",
  "humanreview",
  "merged",
] as const;
export const DashboardSlotId = Schema.Literals(DASHBOARD_SLOT_IDS);
export type DashboardSlotId = typeof DashboardSlotId.Type;

export const DASHBOARD_SLOT_TITLES: Readonly<Record<DashboardSlotId, string>> = {
  decide: "Needs your decision",
  waiting: "Waiting",
  working: "Working",
  autoreview: "Auto review",
  humanreview: "Human review",
  merged: "Recently merged",
};

/** An empty `text` is an empty slot. */
export const ThreadDashboardSlot = Schema.Struct({
  slot: DashboardSlotId,
  text: Schema.String,
  /** Null until the agent first writes the slot. */
  updatedAt: Schema.NullOr(IsoDateTime),
  /** The text the user last marked read, or null if they never did. */
  seenText: Schema.NullOr(Schema.String),
});
export type ThreadDashboardSlot = typeof ThreadDashboardSlot.Type;

/** Every slot, in page order. */
export const ThreadDashboard = Schema.Struct({
  threadId: ThreadId,
  slots: Schema.Array(ThreadDashboardSlot),
});
export type ThreadDashboard = typeof ThreadDashboard.Type;

export const THREAD_DASHBOARD_WS_METHODS = {
  subscribe: "fork.threadDashboard.subscribe",
  markSeen: "fork.threadDashboard.markSeen",
} as const;

export const ThreadDashboardMarkSeenInput = Schema.Struct({
  threadId: ThreadId,
  slot: DashboardSlotId,
  /** The text the user read. A slot whose text has changed since stays unread. */
  text: Schema.String,
});

export const WsSubscribeThreadDashboardRpc = Rpc.make(THREAD_DASHBOARD_WS_METHODS.subscribe, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: ThreadDashboard,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsThreadDashboardMarkSeenRpc = Rpc.make(THREAD_DASHBOARD_WS_METHODS.markSeen, {
  payload: ThreadDashboardMarkSeenInput,
  error: EnvironmentAuthorizationError,
});
