import type { EnvironmentId } from "@t3tools/contracts";
import { memo, use } from "react";

import { tickTextContent } from "../../lib/tickTextContent";
import type { TimelineEntry } from "../../session-logic";
import { SubThreadViewContext } from "../subThreads/subThreadsState";
import {
  type IndicatorRun,
  type IndicatorRuntime,
  showsWorkingIndicator,
  workingForText,
} from "./chatWorkingIndicator.logic";
import { runPlaces } from "./displayModeTimeline";

/** Chat mode's working line, floating above the composer in the view where the live run answers. */
export function ChatWorkingIndicator(props: {
  readonly chatMode: boolean;
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly working: boolean;
  readonly localSendPending: boolean;
  readonly activityRun: IndicatorRun | null;
  readonly runtime: IndicatorRuntime | null;
  readonly startedAt: string | null;
  readonly composerInset: number;
}) {
  const view = use(SubThreadViewContext);
  if (
    !props.chatMode ||
    !props.working ||
    !showsWorkingIndicator({ ...props, places: runPlaces(props.entries), view })
  )
    return null;
  return (
    <WorkingIndicatorLayer
      startedAt={props.startedAt}
      environmentId={props.environmentId}
      composerInset={props.composerInset}
    />
  );
}

export const WorkingIndicatorLayer = memo(function WorkingIndicatorLayer(props: {
  readonly startedAt: string | null;
  readonly environmentId: EnvironmentId;
  readonly composerInset: number;
}) {
  const { startedAt, environmentId } = props;
  return (
    <div
      data-chat-working-indicator="true"
      className="chat-composer-lane pointer-events-none absolute inset-x-0 z-10"
      style={{ bottom: props.composerInset + 2 }}
    >
      <div className="mx-auto w-full max-w-(--chat-content-max-width)">
        <div className="flex h-6 w-fit items-baseline rounded-md bg-background px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
          {startedAt === null ? (
            "Working…"
          ) : (
            <span
              ref={tickTextContent(
                (nowMs) => workingForText(startedAt, environmentId, nowMs),
                true,
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
});
