import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { THREAD_DASHBOARD_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";

export const threadDashboard = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:thread-dashboard",
  tag: THREAD_DASHBOARD_WS_METHODS.subscribe,
});

export const markThreadDashboardSlotSeen = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:thread-dashboard:mark-seen",
  tag: THREAD_DASHBOARD_WS_METHODS.markSeen,
});
