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
  type LayoutNode,
  leaves,
  linkedFileTabId,
  PANE_ID,
  PRIMARY_CHAT,
  PRIMARY_PAYLOAD,
  secondaryChatTabId,
  seedWorkArea,
  SPLIT_ID,
  type TabId,
  type WorkAreaLayout,
  type WorkAreaTab,
  withoutArmed,
} from "./workArea.logic";
import { NO_VIEW } from "./workAreaGeometry.logic";
import { reconcileWorkArea } from "./workAreaPlacement.logic";

/** `partialize`, per record: an older build gets a real active tab and opens a docked panel. */
export function persistedRecord(record: ThreadRightPanelState): ThreadRightPanelState {
  const layout = record.workArea;
  if (layout === undefined) return record;
  const surfaceIds = new Set<string>(record.surfaces.map((surface) => surface.id));
  const activeSurfaceId =
    record.activeSurfaceId ??
    leaves(layout.root)
      .map((pane) => pane.active)
      .find((tab) => surfaceIds.has(tab)) ??
    record.surfaces[0]?.id ??
    null;
  return { ...record, activeSurfaceId, workArea: withoutArmed(layout) };
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

function parseTab(tab: TabId, raw: unknown): WorkAreaTab | null {
  if (!isObject(raw)) return null;
  switch (raw.kind) {
    case "primary-chat":
      return tab === PRIMARY_CHAT ? PRIMARY_PAYLOAD : null;
    case "surface":
      return tab.startsWith("chat") || tab.startsWith("linked:") ? null : { kind: "surface" };
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
    const ids = tabs.filter((tab): tab is string => typeof tab === "string").map(asTabId);
    if (ids.length !== tabs.length || !isNonEmpty(ids)) return null;
    panes.add(id);
    return { kind: "pane", id: asPaneId(id), tabs: ids, active: asTabId(active) };
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
    const tab = asTabId(key);
    const payload = parseTab(tab, value);
    if (!payload) return null;
    tabs[tab] = payload;
  }
  return { root, tabs, focused: asPaneId(raw.focused), seq: raw.seq };
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
  const { workArea, split: _split, chatActiveOver: _chatActiveOver, ...record } = raw;
  const stored: unknown = workArea;
  const layout =
    stored === undefined ? seedWorkArea(record) : (restoreWorkArea(stored) ?? DEFAULT_LAYOUT);
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
