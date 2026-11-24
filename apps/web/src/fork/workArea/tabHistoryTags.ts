import type { HistoryLocation } from "@tanstack/react-router";

import { readTabEntry, type TabEntry } from "./tabHistory.logic";

const STORAGE_KEY = "t3code:work-area-tab-history:v1";
const MAX_TAGS = 500;

type EntryState = HistoryLocation["state"];
type TagStorage = Pick<Storage, "getItem" | "setItem">;

/** Map from a router history entry's state key to its recorded `TabEntry`. */
export type TabTags = {
  readonly get: (state: EntryState) => TabEntry | null;
  readonly set: (state: EntryState, tag: TabEntry) => void;
  /** Marks every recorded entry of `thread` as `dead` and saves the map. */
  readonly markDead: (thread: string) => void;
};

const entryKey = (state: EntryState) => state.__TSR_key ?? state.key;

function readStored(storage: () => TagStorage | undefined): Map<string, TabEntry> {
  const tags = new Map<string, TabEntry>();
  try {
    const rows: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(rows)) return tags;
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[0] !== "string") continue;
      const tag = readTabEntry(row[1]);
      if (tag !== null) tags.set(row[0], tag);
    }
  } catch {
    // Blocked or corrupted storage starts with no tags.
  }
  return tags;
}

/**
 * Creates a `TabTags` map backed by `storage`, keeping the newest 500 entries across reloads.
 * Ignores blocked or corrupted storage and falls back to memory for the current page load.
 */
export function createTabTags(storage: () => TagStorage | undefined): TabTags {
  const tags = readStored(storage);
  const save = () => {
    try {
      storage()?.setItem(STORAGE_KEY, JSON.stringify([...tags]));
    } catch {
      // Full or blocked storage keeps the tags for this page load only.
    }
  };
  return {
    get: (state) => {
      const key = entryKey(state);
      return key === undefined ? null : (tags.get(key) ?? null);
    },
    set: (state, tag) => {
      const key = entryKey(state);
      if (key === undefined) return;
      tags.delete(key);
      tags.set(key, tag);
      for (const oldest of tags.keys()) {
        if (tags.size <= MAX_TAGS) break;
        tags.delete(oldest);
      }
      save();
    },
    markDead: (thread) => {
      let changed = false;
      for (const [key, tag] of tags) {
        if (tag.thread !== thread || tag.dead) continue;
        tags.set(key, { ...tag, dead: true });
        changed = true;
      }
      if (changed) save();
    },
  };
}

// Session storage lasts as long as this tab's history entries, across reloads.
/** Shared `TabTags` map backed by `window.sessionStorage` when running in a browser. */
export const tabHistoryTags = createTabTags(() =>
  typeof window === "undefined" ? undefined : window.sessionStorage,
);
