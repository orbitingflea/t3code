import * as Equal from "effect/Equal";
import { renderCodexDirectivesForCopy } from "@t3tools/client-runtime/codex-markdown-directives";
import {
  omitSupersededLifecycleMarkers,
  summarizeToolGroup,
  toolGroupSummaryKind,
  type ToolGroupSummaryKind,
} from "@t3tools/client-runtime/work-log/presentation";
export {
  normalizeCompactToolLabel,
  summarizeToolGroup,
  toolGroupAction,
  workLogEntryIsLocalCodeSearch,
} from "@t3tools/client-runtime/work-log/presentation";
import {
  formatDuration,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@t3tools/contracts";

export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false,
): boolean {
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}

export interface TimelineEndState {
  readonly isAtEnd?: boolean;
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
}

/**
 * Follow re-arm band above the hard bottom. Strict on purpose: LegendList's
 * isNearEnd fires within half a viewport, which re-armed live-follow while the
 * user was reading history and yanked them back down on the next stream chunk.
 * A small pixel band (instead of the 1px isAtEnd epsilon alone) keeps re-arming
 * reliable while streaming content is still growing under the viewport.
 */
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(
  state: TimelineEndState | undefined,
  endInset = 0,
): boolean | undefined {
  if (!state) {
    return undefined;
  }
  if (state.isAtEnd) {
    return true;
  }
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  // contentLength includes the end inset (composer overlay), so subtract it to
  // measure the distance to the real content bottom.
  return contentLength - scroll - scrollLength - endInset <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text);
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered, so the side gutter between them shrinks under browser zoom or a
 * narrow pane. A fixed-width hover strip would then sit on top of the message
 * text and swallow its pointer events. Cap the strip's width so it never
 * extends past the gutter into the content column; 0 disables the strip.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Once the preview is open, keep the full preview and the space leading to it
 * interactive. The collapsed strip remains gutter-capped so it cannot block
 * selecting message text.
 */
export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  updatedAt: string;
  streaming: boolean;
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      isExpandedToolGroupEntry: boolean;
      isLastExpandedToolGroupEntry: boolean;
    }
  | {
      kind: "work-live";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      groupedEntries: WorkLogEntry[];
      groupId: string;
      expanded: boolean;
      active: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      summary: string;
      summaryKind: ToolGroupSummaryKind;
      hasFailure: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      label: string;
      expanded: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantMeta: boolean;
      /** Draws the separator of the fold this message closes. */
      showsTurnFoldSeparator: boolean;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "working";
      id: string;
      createdAt: string | null;
    }
  | {
      kind: "thinking";
      id: string;
      createdAt: string | null;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }

  return result;
}

function workGroupIdentity(timelineEntryId: string, entry: WorkLogEntry): string {
  return entry.toolCallId
    ? `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}`
    : timelineEntryId;
}

function workGroupId(timelineEntryId: string, entry: WorkLogEntry): string {
  return `work-group:${workGroupIdentity(timelineEntryId, entry)}`;
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  const visible = showCopyButton && hasText && !streaming;
  return {
    text: hasText ? (visible ? renderCodexDirectivesForCopy(text) : text) : null,
    visible,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

interface TurnFold {
  turnId: TurnId;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
  /** The segment's direct-spawn CTA, carrying every direct spawn the fold absorbed. */
  spawnRow: { entryId: string; entry: WorkLogEntry } | null;
  /** The assistant message that closes the segment, when one does. */
  terminalEntryId: string | null;
}

/**
 * The session's running turn is authoritative when latestTurn briefly lags or
 * regresses behind it. Otherwise, the latest turn counts as unsettled while it
 * is still running (or has not recorded a completion). This is deliberately
 * keyed on turn lifecycle rather than transient working state: right after the
 * user sends a message, the previous turn is still the "active" one until the
 * server creates the new turn, and folding must not flicker through that window.
 */
function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

function lastUserMessageIndex(timelineEntries: ReadonlyArray<TimelineEntry>): number {
  return timelineEntries.findLastIndex(
    (entry) => entry.kind === "message" && entry.message.role === "user",
  );
}

function timelineEntryTurnId(entry: TimelineEntry): TurnId | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" ? (entry.message.turnId ?? null) : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.turnId;
  }
  return entry.kind === "work" ? (entry.entry.turnId ?? null) : null;
}

function workEntryIsActiveTurnActivity(entry: WorkLogEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    entry.sourceActivityKind === "task.progress" ||
    (entry.toolLifecycleStatus === undefined && workLogEntryIsToolLike(entry))
  );
}

/**
 * User messages cut the timeline into segments, and every settled segment
 * folds behind one "Worked for ..." row anchored at its first hidden entry.
 * A segment keeps only its direct-spawn CTA row and, when an assistant
 * message closes it, that message. Because the timeline is in transcript
 * order, a steer (a user message sent mid-turn) simply starts a new segment:
 * the work it interrupted folds above it and the work it caused folds below.
 */
function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
}): ReadonlyMap<string, TurnFold> {
  interface Segment {
    /** Last turn id in the segment; folds expand per turn id. */
    turnId: TurnId | null;
    entries: Array<TimelineEntry>;
    /**
     * The user message that opened the segment. Entry timestamps alone
     * undercount the duration: the first entry appears only once the
     * provider starts producing output.
     */
    startBoundary: string | null;
  }
  const segments: Array<Segment> = [{ turnId: null, entries: [], startBoundary: null }];
  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      segments.push({ turnId: null, entries: [], startBoundary: entry.message.createdAt });
      continue;
    }
    const segment = segments.at(-1)!;
    segment.turnId = timelineEntryTurnId(entry) ?? segment.turnId;
    segment.entries.push(entry);
  }
  // New entries only ever append, so while a turn is unsettled the last
  // segment is the live one; everything above it is finished.
  const liveSegment = input.unsettledTurnId === null ? null : segments.at(-1);
  // The latest turn's own clock covers the segment that ends it: a stop has
  // no entry of its own, and a turn may start before it produces any entry.
  const latestTurnSegment = segments.findLast((segment) =>
    segment.entries.some((entry) => timelineEntryTurnId(entry) === input.latestTurn?.turnId),
  );

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const segment of segments) {
    const { turnId } = segment;
    if (turnId === null || segment === liveSegment) {
      continue;
    }
    if (segment.entries.some((entry) => entry.kind === "message" && entry.message.streaming)) {
      continue;
    }
    // A turn id came from an entry, so the segment is not empty.
    const lastEntry = segment.entries.at(-1)!;
    const terminalEntry =
      lastEntry.kind === "message" && lastEntry.message.role === "assistant" ? lastEntry : null;
    const hiddenEntryIds = new Set<string>();
    let spawnRow: TurnFold["spawnRow"] = null;
    for (const entry of segment.entries) {
      if (entry === terminalEntry) {
        continue;
      }
      // Agent-spawn CTA rows never fold: workflows outlive their launching
      // turn (dynamic spawns, background execution), and folding the CTA
      // when the turn settles makes a still-running fleet invisible. Direct
      // spawns are batched per turn id upstream, so a synthetic continuation
      // yields a second CTA; the fold merges them into the segment's first one.
      if (entry.kind === "work" && entry.entry.agentSpawn !== undefined) {
        if (entry.entry.agentSpawn.workflowId !== null) {
          continue;
        }
        if (spawnRow === null) {
          spawnRow = { entryId: entry.id, entry: entry.entry };
          continue;
        }
        const agentTaskIds = new Set([
          ...(spawnRow.entry.agentSpawn?.agentTaskIds ?? []),
          ...entry.entry.agentSpawn.agentTaskIds,
        ]);
        spawnRow.entry = {
          ...spawnRow.entry,
          agentSpawn: { workflowId: null, agentTaskIds: [...agentTaskIds] },
        };
      }
      hiddenEntryIds.add(entry.id);
    }
    const firstHiddenEntry = segment.entries.find((entry) => hiddenEntryIds.has(entry.id));
    if (!firstHiddenEntry) {
      continue;
    }

    const turn = segment === latestTurnSegment ? input.latestTurn : null;
    const lastEntryEnd =
      lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const elapsedMs = computeElapsedMs(
      segment.startBoundary ?? turn?.startedAt ?? segment.entries[0]!.createdAt,
      maxIsoTimestamp(lastEntryEnd, turn?.completedAt ?? null) ?? lastEntryEnd,
    );
    const duration = elapsedMs !== null ? formatDuration(elapsedMs) : null;
    const label =
      turn?.state === "interrupted"
        ? duration
          ? `You stopped after ${duration}`
          : "You stopped this response"
        : duration
          ? `Worked for ${duration}`
          : "Worked";

    foldsByAnchorEntryId.set(firstHiddenEntry.id, {
      turnId,
      anchorEntryId: firstHiddenEntry.id,
      createdAt: firstHiddenEntry.createdAt,
      hiddenEntryIds,
      label,
      spawnRow,
      terminalEntryId: terminalEntry?.id ?? null,
    });
  }
  return foldsByAnchorEntryId;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  expandedTurnIds?: ReadonlySet<TurnId>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
  });
  const collapsedEntryIds = new Set<string>();
  const mergedSpawnEntries = new Map<string, WorkLogEntry>();
  const foldTerminalEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (fold.terminalEntryId !== null) {
      foldTerminalEntryIds.add(fold.terminalEntryId);
    }
    if (!input.expandedTurnIds?.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
      if (fold.spawnRow) {
        mergedSpawnEntries.set(fold.spawnRow.entryId, fold.spawnRow.entry);
      }
    }
  }

  let activeTurnHeaderIndex = input.timelineEntries.length;
  if (input.isWorking) {
    const latestUserMessageIndex = lastUserMessageIndex(input.timelineEntries);
    const firstOwnedAfterUser =
      unsettledTurnId === null
        ? -1
        : input.timelineEntries.findIndex(
            (entry, index) =>
              index > latestUserMessageIndex && timelineEntryTurnId(entry) === unsettledTurnId,
          );
    activeTurnHeaderIndex =
      firstOwnedAfterUser >= 0 ? firstOwnedAfterUser : latestUserMessageIndex + 1;
  }
  const entryBelongsToActiveTurn = (entry: TimelineEntry, index: number) =>
    input.isWorking &&
    index >= activeTurnHeaderIndex &&
    (unsettledTurnId === null || timelineEntryTurnId(entry) === unsettledTurnId);
  const workEntryIsInActiveRun = (entry: WorkLogEntry) =>
    input.isWorking &&
    unsettledTurnId !== null &&
    entry.toolLifecycleStatus === "inProgress" &&
    entry.turnId === unsettledTurnId;
  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  for (let index = input.timelineEntries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
    const entry = input.timelineEntries[index]!;
    if (
      !entryBelongsToActiveTurn(entry, index) ||
      entry.kind !== "work" ||
      entry.entry.agentSpawn !== undefined ||
      entry.entry.tone === "error"
    ) {
      break;
    }
    activeToolEntries.unshift(entry);
  }
  const visibleActiveToolEntries = omitSupersededLifecycleMarkers(
    activeToolEntries.filter((entry) => workEntryIsVisibleInGroup(entry.entry, true)),
    (entry) => entry.entry,
  );
  const activeWorkAnchor = activeToolEntries[0];
  const latestVisibleToolEntry = visibleActiveToolEntries.at(-1);
  const latestRunningToolEntry = visibleActiveToolEntries.findLast((entry) =>
    workEntryIsActiveTurnActivity(entry.entry),
  );
  const latestToolKeepsActivityLive =
    latestRunningToolEntry !== undefined ||
    (latestVisibleToolEntry !== undefined &&
      workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry));
  const activeWorkPlacementEntryId = latestVisibleToolEntry?.id;
  const activeWorkRow =
    activeWorkAnchor && latestVisibleToolEntry
      ? (() => {
          const groupId = workGroupId(activeWorkAnchor.id, activeWorkAnchor.entry);
          return {
            kind: "work-live" as const,
            id: latestToolKeepsActivityLive
              ? LIVE_ACTIVITY_ROW_ID
              : `work-live:${workGroupIdentity(activeWorkAnchor.id, activeWorkAnchor.entry)}`,
            createdAt: activeWorkAnchor.createdAt,
            entry: (latestRunningToolEntry ?? latestVisibleToolEntry).entry,
            groupedEntries: visibleActiveToolEntries.map((entry) => entry.entry),
            groupId,
            expanded: input.expandedWorkGroupIds?.has(groupId) ?? false,
            active: latestToolKeepsActivityLive,
          };
        })()
      : null;
  const activeWorkEntryIds = new Set(
    activeWorkRow === null ? [] : activeToolEntries.map((entry) => entry.id),
  );
  const appendWorkingRow = () => {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  };
  let hasActivityRow = false;
  const appendActiveWorkRows = () => {
    if (activeWorkRow === null) return;
    nextRows.push(activeWorkRow);
    hasActivityRow ||= activeWorkRow.active;
    if (!activeWorkRow.expanded) return;
    for (const [entryIndex, workEntry] of activeWorkRow.groupedEntries.entries()) {
      nextRows.push({
        kind: "work",
        id: workEntry.id,
        createdAt: workEntry.createdAt,
        groupedEntries: [workEntry],
        isExpandedToolGroupEntry: true,
        isLastExpandedToolGroupEntry: entryIndex === activeWorkRow.groupedEntries.length - 1,
      });
    }
  };

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (input.isWorking && index === activeTurnHeaderIndex) {
      appendWorkingRow();
    }

    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    const anchoredTurnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (anchoredTurnFold) {
      nextRows.push({
        kind: "turn-fold",
        id: `turn-fold:${anchoredTurnFold.anchorEntryId}`,
        createdAt: anchoredTurnFold.createdAt,
        turnId: anchoredTurnFold.turnId,
        label: anchoredTurnFold.label,
        expanded: input.expandedTurnIds?.has(anchoredTurnFold.turnId) ?? false,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      if (timelineEntry.entry.agentSpawn !== undefined || timelineEntry.entry.tone === "error") {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [mergedSpawnEntries.get(timelineEntry.id) ?? timelineEntry.entry],
          isExpandedToolGroupEntry: false,
          isLastExpandedToolGroupEntry: false,
        });
        continue;
      }
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.agentSpawn !== undefined ||
          nextEntry.entry.tone === "error" ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = omitSupersededLifecycleMarkers(
        groupedEntries.filter((entry) =>
          workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry)),
        ),
        (entry) => entry,
      );
      if (visibleGroupedEntries.length > 0) {
        const activeInProgressToolEntries = visibleGroupedEntries.filter(workEntryIsInActiveRun);
        if (activeInProgressToolEntries.length > 0) {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const latestActiveToolEntry = activeInProgressToolEntries.at(-1)!;
          nextRows.push({
            kind: "work-live",
            id: `work-live:${workGroupIdentity(timelineEntry.id, timelineEntry.entry)}`,
            createdAt: timelineEntry.createdAt,
            entry: latestActiveToolEntry,
            groupedEntries: visibleGroupedEntries,
            groupId,
            expanded,
            active: true,
          });
          hasActivityRow = true;
          if (expanded) {
            for (const [entryIndex, workEntry] of visibleGroupedEntries.entries()) {
              nextRows.push({
                kind: "work",
                id: workEntry.id,
                createdAt: workEntry.createdAt,
                groupedEntries: [workEntry],
                isExpandedToolGroupEntry: true,
                isLastExpandedToolGroupEntry: entryIndex === visibleGroupedEntries.length - 1,
              });
            }
          }
        } else {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const summaryKind = toolGroupSummaryKind(visibleGroupedEntries);
          const latestToolEntry = visibleGroupedEntries.findLast(workLogEntryIsToolLike);
          nextRows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            summary:
              visibleGroupedEntries.length === 1 &&
              !workLogEntryIsToolLike(visibleGroupedEntries[0]!)
                ? visibleGroupedEntries[0]!.label
                : summarizeToolGroup(visibleGroupedEntries),
            summaryKind,
            hasFailure:
              latestToolEntry !== undefined &&
              workEntryDisplayIndicatesToolFailure(latestToolEntry),
          });
          if (expanded) {
            for (const [entryIndex, workEntry] of visibleGroupedEntries.entries()) {
              nextRows.push({
                kind: "work",
                id: workEntry.id,
                createdAt: workEntry.createdAt,
                groupedEntries: [workEntry],
                isExpandedToolGroupEntry: true,
                isLastExpandedToolGroupEntry: entryIndex === visibleGroupedEntries.length - 1,
              });
            }
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    const assistantTurnStillInProgress =
      timelineEntry.message.role === "assistant" &&
      unsettledTurnId !== null &&
      timelineEntry.message.turnId === unsettledTurnId;

    const durationStart =
      durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt;

    // While the turn is still running, the latest assistant message is only
    // provisionally terminal — withhold the metadata row until the turn
    // settles so commentary doesn't flash timestamps mid-work.
    const showAssistantMeta =
      timelineEntry.message.role === "assistant" &&
      (terminalAssistantMessageIds.has(timelineEntry.message.id) ||
        foldTerminalEntryIds.has(timelineEntry.id)) &&
      !assistantTurnStillInProgress;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart,
      showAssistantMeta,
      showsTurnFoldSeparator: foldTerminalEntryIds.has(timelineEntry.id),
      showAssistantCopyButton: showAssistantMeta,
      assistantCopyStreaming: timelineEntry.message.streaming || assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        timelineEntry.message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
          : undefined,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
    });
  }

  if (input.isWorking && activeTurnHeaderIndex === input.timelineEntries.length) {
    appendWorkingRow();
  }
  if (input.isWorking && !hasActivityRow) {
    nextRows.push({
      kind: "thinking",
      id: LIVE_ACTIVITY_ROW_ID,
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
    case "thinking":
      return a.createdAt === (b as typeof a).createdAt;

    case "turn-fold": {
      const bf = b as typeof a;
      return (
        a.turnId === bf.turnId &&
        a.createdAt === bf.createdAt &&
        a.label === bf.label &&
        a.expanded === bf.expanded
      );
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work": {
      const bw = b as typeof a;
      return (
        a.isExpandedToolGroupEntry === bw.isExpandedToolGroupEntry &&
        a.isLastExpandedToolGroupEntry === bw.isLastExpandedToolGroupEntry &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-live": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.expanded === bw.expanded &&
        a.active === bw.active &&
        Equal.equals(a.entry, bw.entry) &&
        Equal.equals(a.groupedEntries, bw.groupedEntries)
      );
    }

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.summary === bw.summary &&
        a.summaryKind === bw.summaryKind &&
        a.hasFailure === bw.hasFailure
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.durationStart === bm.durationStart &&
        a.showAssistantMeta === bm.showAssistantMeta &&
        a.showsTurnFoldSeparator === bm.showsTurnFoldSeparator &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }
  }
}
