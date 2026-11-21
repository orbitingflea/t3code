import { toServerClock } from "@t3tools/client-runtime/clock";
import type { ThreadRunSummary, ThreadRuntimeSummary } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";

import { isLatestRunSettled } from "../../session-logic";
import type { RunPlaces } from "./displayModeTimeline";
import { useThreadDisplayMode } from "./useThreadDisplayMode";

export const WORKING_INDICATOR_RESERVE_PX = 28;

export type IndicatorRun = Pick<ThreadRunSummary, "runId" | "startedAt" | "completedAt" | "status">;
export type IndicatorRuntime = Pick<ThreadRuntimeSummary, "status" | "activeRunId">;

/**
 * Whether the view `view` (a sub-thread's first message, or null for the main list) shows the
 * working line: the view where the live run answers, or before the run has a place, the view that
 * sent it, else the main list.
 */
export function showsWorkingIndicator(input: {
  readonly working: boolean;
  readonly localSendPending: boolean;
  readonly activityRun: IndicatorRun | null;
  readonly runtime: IndicatorRuntime | null;
  readonly places: RunPlaces;
  readonly view: string | null;
}): boolean {
  if (!input.working) return false;
  const run = isLatestRunSettled(input.activityRun, input.runtime) ? null : input.activityRun;
  if (run !== null && input.places.has(run.runId))
    return input.places.get(run.runId) === input.view;
  if (input.localSendPending) return true;
  // A queued run gets its message only when it starts, and that message may be a reply.
  if (run?.status === "queued") return false;
  return input.view === null;
}

/** ScrollToEndButton's bottom: unchanged in Normal (reserve 0); in Chat, above the reserved row. */
export function scrollToEndBottom(clearance: number, composerInset: number, reserve: number) {
  return reserve === 0 ? clearance + 4 : composerInset + 4 + reserve;
}

/** "Working for 1m 5s", in English units, on the server's clock. */
export function workingForText(
  startIso: string,
  environmentId: EnvironmentId,
  nowMs: number,
): string {
  const startedAtMs = Date.parse(startIso);
  const seconds = Number.isFinite(startedAtMs)
    ? Math.max(0, Math.floor((toServerClock(environmentId, nowMs) - startedAtMs) / 1000))
    : 0;
  return `Working for ${seconds < 60 ? `${seconds}s` : formatDuration(seconds * 1000)}`;
}

/** The reserve a chat view keeps below its last row: constant per mode, never per working state. */
export function useChatWorkingReserve(threadRef: ScopedThreadRef | null): number {
  return useThreadDisplayMode(threadRef).subThreads ? WORKING_INDICATOR_RESERVE_PX : 0;
}
