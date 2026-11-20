import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ChatFileAttachment,
  EnvironmentId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ThreadRightPanelState } from "~/rightPanelStore";

import {
  asPaneId,
  asSplitId,
  asTabId,
  DEFAULT_LAYOUT,
  isNonEmpty,
  LAUNCHER,
  type LayoutNode,
  leaves,
  type PaneNode,
  linkedFileTabId,
  PANE_ID,
  PRIMARY_CHAT,
  PRIMARY_PAYLOAD,
  replyTabId,
  secondaryChatTabId,
  seedWorkArea,
  SPLIT_ID,
  surfaceTabId,
  type TabId,
  type WorkAreaLayout,
  type WorkAreaTab,
  withoutArmed,
  withRevealed,
} from "./workArea.logic";
import { NO_VIEW } from "./workAreaGeometry.logic";
import { unfloatTab } from "./workAreaFloat.logic";
import { reconcileWorkArea } from "./workAreaPlacement.logic";

/**
 * Prepares a record for persistence. Sets a real `activeSurfaceId` for older builds. Drops
 * `revealed`, the reply tab that the last Find or quote reveal opened.
 */
export function persistedRecord(record: ThreadRightPanelState): ThreadRightPanelState {
  const layout = record.workArea;
  if (layout === undefined) return record;
  const surfaceIds = new Set<string>(record.surfaces.map((surface) => surface.id));
  const activeSurfaceId =
    record.activeSurfaceId ??
    leaves(layout.root)
      .map((pane) => pane.active)
      .find((tab) => surfaceIds.has(tab)) ??
    record.surfaces.find((surface) => surfaceTabId(surface.id) !== layout.floating)?.id ??
    null;
  return {
    ...record,
    activeSurfaceId,
    workArea: withRevealed(
      layout.floating === undefined
        ? withoutArmed(layout)
        : unfloatTab(withoutArmed(layout), layout.floating),
      undefined,
    ),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseThread(raw: unknown): ScopedThreadRef | null {
  if (!isObject(raw)) return null;
  const { environmentId, threadId } = raw;
  if (typeof environmentId !== "string" || typeof threadId !== "string") return null;
  if (environmentId === "" || threadId === "") return null;
  return scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId));
}

const isAttachment = Schema.is(ChatFileAttachment);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// A lone surrogate is valid JSON, but a reply tab id cannot URI-encode it.
const encodable = (value: string) => !/\p{Cs}/u.test(value);

function parseTab(tab: TabId, raw: unknown): WorkAreaTab | null {
  if (!isObject(raw)) return null;
  switch (raw.kind) {
    case "primary-chat":
      return tab === PRIMARY_CHAT ? PRIMARY_PAYLOAD : null;
    case "surface":
      return tab.startsWith("chat") ||
        tab.startsWith("linked:") ||
        tab.startsWith("reply:") ||
        tab === LAUNCHER
        ? null
        : { kind: "surface" };
    case "launcher":
      return tab === LAUNCHER ? { kind: "launcher" } : null;
    case "sub-thread": {
      const thread = parseThread(raw.thread);
      const { first } = raw;
      if (!thread || typeof first !== "string" || first === "") return null;
      if (![thread.environmentId, thread.threadId, first].every(encodable)) return null;
      return replyTabId(thread, first) === tab ? { kind: "sub-thread", thread, first } : null;
    }
    case "secondary-chat": {
      const thread = parseThread(raw.thread);
      if (!thread || !isCount(raw.placement) || secondaryChatTabId(thread) !== tab) return null;
      return { kind: "secondary-chat", thread, placement: raw.placement };
    }
    case "linked-file": {
      const source = parseThread(raw.source);
      const { path, line, reveal } = raw;
      if (!source || typeof path !== "string" || !isCount(reveal)) return null;
      if (line !== null && !(typeof line === "number" && Number.isSafeInteger(line) && line > 0)) {
        return null;
      }
      const attachment =
        raw.attachment === undefined
          ? undefined
          : isAttachment(raw.attachment)
            ? raw.attachment
            : null;
      if (attachment === null || linkedFileTabId(source, path, attachment?.id) !== tab) return null;
      return {
        kind: "linked-file",
        source,
        path,
        line,
        reveal,
        ...(attachment === undefined ? {} : { attachment }),
      };
    }
    default:
      return null;
  }
}

// Builds before side chat tabs became `thread` tabs saved their ids as `side-chat:<thread>`.
const renamedTab = (id: string) =>
  asTabId(id.startsWith("side-chat:") ? `thread:${id.slice("side-chat:".length)}` : id);

const MAX_DEPTH = 32;

function parseNode(
  raw: unknown,
  depth: number,
  panes: Set<string>,
  splits: Set<string>,
): LayoutNode | null {
  if (depth > MAX_DEPTH || !isObject(raw)) return null;
  if (raw.kind === "pane") {
    const { id, tabs, active } = raw;
    if (typeof id !== "string" || !PANE_ID.test(id) || panes.has(id)) return null;
    if (!Array.isArray(tabs) || typeof active !== "string") return null;
    const ids = tabs.filter((tab): tab is string => typeof tab === "string").map(renamedTab);
    if (ids.length !== tabs.length || !isNonEmpty(ids)) return null;
    panes.add(id);
    return { kind: "pane", id: asPaneId(id), tabs: ids, active: renamedTab(active) };
  }
  if (raw.kind !== "split") return null;
  const { id, axis, ratio } = raw;
  if (typeof id !== "string" || !SPLIT_ID.test(id) || splits.has(id)) return null;
  if ((axis !== "row" && axis !== "column") || typeof ratio !== "number") return null;
  if (!Number.isFinite(ratio)) return null;
  splits.add(id);
  const first = parseNode(raw.first, depth + 1, panes, splits);
  const second = first && parseNode(raw.second, depth + 1, panes, splits);
  if (!first || !second) return null;
  return { kind: "split", id: asSplitId(id), axis, ratio, first, second };
}

/** Parses a stored `workArea`. Null for anything malformed; repair handles the rest. */
export function restoreWorkArea(raw: unknown): WorkAreaLayout | null {
  if (!isObject(raw) || !isObject(raw.tabs) || !isCount(raw.seq)) return null;
  const panes = new Set<string>();
  const root = parseNode(raw.root, 0, panes, new Set());
  if (!root || typeof raw.focused !== "string" || !panes.has(raw.focused)) return null;
  const tabs: Record<TabId, WorkAreaTab> = {};
  for (const [key, value] of Object.entries(raw.tabs)) {
    const tab = renamedTab(key);
    const payload = parseTab(tab, value);
    if (!payload) return null;
    tabs[tab] = payload;
  }
  return { root, tabs, focused: asPaneId(raw.focused), seq: raw.seq };
}

/**
 * A record from the right panel's two-pane split (`split`, before the work area): the Chat on the
 * left, then the split's two groups with their shown tabs and ratio. Null when it does not parse.
 */
function legacySplitLayout(
  record: Pick<ThreadRightPanelState, "isOpen" | "activeSurfaceId" | "surfaces">,
  raw: unknown,
): WorkAreaLayout | null {
  if (!isObject(raw)) return null;
  const { rightIds, otherShownId, ratio } = raw;
  if (!Array.isArray(rightIds) || typeof otherShownId !== "string") return null;
  const right = new Set(
    rightIds.filter((id): id is string => typeof id === "string").map(renamedTab),
  );
  const ids = record.surfaces.map((surface) => surfaceTabId(surface.id));
  const left = ids.filter((tab) => !right.has(tab));
  const second = ids.filter((tab) => right.has(tab));
  if (!isNonEmpty(left) || !isNonEmpty(second)) return null;
  const active = record.activeSurfaceId === null ? null : renamedTab(record.activeSurfaceId);
  const activeGroup = second.some((tab) => tab === active) ? 2 : 1;
  const focused = record.isOpen ? activeGroup : 0;
  const shown = renamedTab(otherShownId);
  const pane = (n: 1 | 2, tabs: PaneNode["tabs"]): PaneNode => {
    const pick = n === activeGroup ? active : shown;
    return {
      kind: "pane",
      id: asPaneId(`p${n}`),
      tabs,
      active: tabs.find((tab) => tab === pick) ?? tabs[0],
    };
  };
  return {
    root: {
      kind: "split",
      id: asSplitId("s1"),
      axis: "row",
      ratio: 0.5,
      first: { kind: "pane", id: asPaneId("p0"), tabs: [PRIMARY_CHAT], active: PRIMARY_CHAT },
      second: {
        kind: "split",
        id: asSplitId("s2"),
        axis: "row",
        ratio: typeof ratio === "number" && Number.isFinite(ratio) ? ratio : 0.5,
        first: pane(1, left),
        second: pane(2, second),
      },
    },
    tabs: { [PRIMARY_CHAT]: PRIMARY_PAYLOAD },
    focused: asPaneId(`p${focused}`),
    seq: 3,
  };
}

/**
 * The migration's hook: a stored layout survives a storage version bump, and so does an older
 * build's split until the record is restored.
 */
export function migratedWorkArea(
  record: {
    readonly workArea?: unknown;
    readonly split?: unknown;
  } | null,
): { workArea?: WorkAreaLayout; split?: unknown } {
  const layout = restoreWorkArea(record?.workArea);
  if (layout !== null) return { workArea: layout };
  return record?.split === undefined ? {} : { split: record.split };
}

/**
 * zustand's `merge` per record: restores the stored layout (a bad one becomes the default), seeds
 * one for an older build's record, and settles the result.
 */
export function restoredRecord(
  raw: ThreadRightPanelState & { readonly split?: unknown; readonly chatActiveOver?: unknown },
): ThreadRightPanelState {
  if (!isObject(raw) || !Array.isArray(raw.surfaces)) return raw;
  if (!raw.surfaces.every((surface) => isObject(surface) && typeof surface.id === "string")) {
    return raw;
  }
  const { workArea, split, chatActiveOver: _chatActiveOver, ...record } = raw;
  const stored: unknown = workArea;
  const layout =
    stored === undefined
      ? (legacySplitLayout(record, split) ?? seedWorkArea(record))
      : (restoreWorkArea(stored) ?? DEFAULT_LAYOUT);
  return reconcileWorkArea(record, { ...record, workArea: layout }, "automatic", NO_VIEW);
}

/** zustand's `merge`: a same-version load skips `migrate`, so every record settles here. */
export function mergePersistedWorkArea<
  S extends { byThreadKey: Record<string, ThreadRightPanelState> },
>(persisted: unknown, current: S): S {
  const merged: S = { ...current, ...(persisted as Partial<S>) };
  if (!isObject(merged.byThreadKey)) return merged;
  return {
    ...merged,
    byThreadKey: Object.fromEntries(
      Object.entries(merged.byThreadKey).map(([threadKey, record]) => [
        threadKey,
        restoredRecord(record),
      ]),
    ),
  };
}
