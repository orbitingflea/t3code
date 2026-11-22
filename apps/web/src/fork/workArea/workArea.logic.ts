import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { RightPanelKind, RightPanelSurface, ThreadRightPanelState } from "~/rightPanelStore";
import { WORK_AREA_COPY } from "~/fork/forkCopy";
import type { ChatFileAttachment } from "~/types";

export type PaneId = string & { readonly __pane: unique symbol };
export type SplitId = string & { readonly __split: unique symbol };
export type TabId = string & { readonly __tab: unique symbol };

export type WorkAreaTab =
  | { readonly kind: "primary-chat" }
  | {
      readonly kind: "secondary-chat";
      readonly thread: ScopedThreadRef;
      readonly placement: number;
    }
  | { readonly kind: "surface" }
  /** The "Open a surface" view as a tab, so a pane is never empty. */
  | { readonly kind: "launcher" }
  /** One Replies sub-thread of `thread`, by the id of its first message. */
  | { readonly kind: "sub-thread"; readonly thread: ScopedThreadRef; readonly first: string }
  | {
      readonly kind: "linked-file";
      readonly source: ScopedThreadRef;
      readonly path: string;
      readonly line: number | null;
      readonly reveal: number;
      /** A chat attachment of the source thread; `path` is then its name. */
      readonly attachment?: ChatFileAttachment;
      readonly shown?: true;
    };

type LinkedFilePayload = Extract<WorkAreaTab, { kind: "linked-file" }>;
type SubThreadPayload = Extract<WorkAreaTab, { kind: "sub-thread" }>;

type NonEmpty<T> = readonly [T, ...T[]];

export interface PaneNode {
  readonly kind: "pane";
  readonly id: PaneId;
  readonly tabs: NonEmpty<TabId>;
  readonly active: TabId;
}

export type SplitAxis = "row" | "column";

export interface SplitNode {
  readonly kind: "split";
  readonly id: SplitId;
  readonly axis: SplitAxis;
  readonly ratio: number;
  readonly first: LayoutNode;
  readonly second: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

export interface WorkAreaLayout {
  readonly root: LayoutNode;
  readonly tabs: Readonly<Record<TabId, WorkAreaTab>>;
  readonly focused: PaneId;
  readonly seq: number;
  readonly armed?: { readonly pane: PaneId; readonly kind: ArmKind };
  /** The one tab in no pane because it plays in the mini player. Never saved to storage. */
  readonly floating?: TabId;
  readonly revealed?: TabId;
}

export type Edge = "left" | "right" | "top" | "bottom";

export type ArmKind = RightPanelKind | "chat";

// The only constructors of ids; nothing else builds or parses them.
export const PRIMARY_CHAT = "chat" as TabId;
export const LAUNCHER = "launcher" as TabId;
export const secondaryChatTabId = (thread: ScopedThreadRef) =>
  `chat:${scopedThreadKey(thread)}` as TabId;
export const linkedFileTabId = (source: ScopedThreadRef, path: string, attachmentId?: string) =>
  (attachmentId === undefined
    ? `linked:${scopedThreadKey(source)}:${path}`
    : `linked:${scopedThreadKey(source)}:attachment:${attachmentId}`) as TabId;
const replyKey = (thread: ScopedThreadRef, first: string): `reply:${string}` =>
  `reply:${encodeURIComponent(scopedThreadKey(thread))}:${encodeURIComponent(first)}`;
export const replyTabId = (thread: ScopedThreadRef, first: string) =>
  replyKey(thread, first) as TabId;
export const asTabId = (id: string) => id as TabId;
export const asPaneId = (id: string) => id as PaneId;
export const asSplitId = (id: string) => id as SplitId;
export const surfaceTabId = (surfaceId: string): TabId => asTabId(surfaceId);
const paneIdOf = (n: number) => asPaneId(`p${n}`);
const splitIdOf = (n: number) => asSplitId(`s${n}`);
export const PANE_ID = /^p(\d+)$/;
export const SPLIT_ID = /^s(\d+)$/;

/** A workspace entry path without trailing slashes. Entry paths use '/', including on Windows. */
export const workspaceEntryPath = (path: string): string =>
  /^[A-Za-z]:\/+$/.test(path) ? path : path.replace(/\/+$/, "") || path;

export const PRIMARY_PAYLOAD: WorkAreaTab = { kind: "primary-chat" };

export function defaultLayout(seq = 0): WorkAreaLayout {
  const id = paneIdOf(seq);
  return {
    root: { kind: "pane", id, tabs: [PRIMARY_CHAT], active: PRIMARY_CHAT },
    tabs: { [PRIMARY_CHAT]: PRIMARY_PAYLOAD },
    focused: id,
    seq: seq + 1,
  };
}

export const DEFAULT_LAYOUT: WorkAreaLayout = defaultLayout();

export function isDefaultLayout(layout: WorkAreaLayout): boolean {
  const root = layout.root;
  return (
    root.kind === "pane" &&
    root.tabs.length === 1 &&
    root.tabs[0] === PRIMARY_CHAT &&
    layout.armed === undefined &&
    layout.floating === undefined &&
    layout.seq === DEFAULT_LAYOUT.seq
  );
}

export const isNonEmpty = <T>(items: readonly T[]): items is NonEmpty<T> => items.length > 0;

type TabClass = Exclude<WorkAreaTab["kind"], "surface"> | "side-thread" | "surface";

interface TabTraits {
  /** Counts toward the last Chat, which cannot close. */
  readonly chat: boolean;
  /** Holds a message box: keeps composer width and blocks automatic opens from covering it. */
  readonly composer: boolean;
}

const TRAITS: Readonly<Record<TabClass, TabTraits>> = {
  "primary-chat": { chat: true, composer: true },
  "secondary-chat": { chat: true, composer: true },
  "sub-thread": { chat: false, composer: true },
  "side-thread": { chat: false, composer: true },
  "linked-file": { chat: false, composer: false },
  launcher: { chat: false, composer: false },
  surface: { chat: false, composer: false },
};

// Prefix of upstream's ThreadSurface id for side chats and subagents.
const SIDE_THREAD_PREFIX = "thread:";

export const traitsOf = (tab: TabId, payload: WorkAreaTab | undefined): TabTraits =>
  TRAITS[
    payload !== undefined && payload.kind !== "surface"
      ? payload.kind
      : tab.startsWith(SIDE_THREAD_PREFIX)
        ? "side-thread"
        : "surface"
  ];

export const tabTraits = (layout: WorkAreaLayout, tab: TabId): TabTraits =>
  traitsOf(tab, layout.tabs[tab]);

export function leaves(root: LayoutNode): PaneNode[] {
  if (root.kind === "pane") return [root];
  return [...leaves(root.first), ...leaves(root.second)];
}

export function findPane(root: LayoutNode, id: PaneId): PaneNode | undefined {
  return leaves(root).find((pane) => pane.id === id);
}

export function paneHolding(root: LayoutNode, tab: TabId): PaneNode | undefined {
  return leaves(root).find((pane) => pane.tabs.includes(tab));
}

export const chatTabs = (layout: WorkAreaLayout): TabId[] =>
  leaves(layout.root).flatMap((pane) => pane.tabs.filter((tab) => tabTraits(layout, tab).chat));

/** Rebuilds the tree; a pane mapped to null gives its space to its sibling. */
export function mapPanes(
  node: LayoutNode,
  map: (pane: PaneNode) => LayoutNode | null,
): LayoutNode | null {
  if (node.kind === "pane") return map(node);
  const first = mapPanes(node.first, map);
  const second = mapPanes(node.second, map);
  if (first === null) return second;
  if (second === null) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function mapSplits(node: LayoutNode, map: (split: SplitNode) => SplitNode): LayoutNode {
  if (node.kind === "pane") return node;
  const first = mapSplits(node.first, map);
  const second = mapSplits(node.second, map);
  return map(first === node.first && second === node.second ? node : { ...node, first, second });
}

export function setPane(layout: WorkAreaLayout, next: PaneNode): WorkAreaLayout {
  const root = mapPanes(layout.root, (pane) => (pane.id === next.id ? next : pane));
  return root === null || root === layout.root ? layout : { ...layout, root };
}

export function withoutArmed(layout: WorkAreaLayout): WorkAreaLayout {
  if (layout.armed === undefined) return layout;
  const { armed: _armed, ...rest } = layout;
  return rest;
}

export function withRevealed(layout: WorkAreaLayout, tab: TabId | undefined): WorkAreaLayout {
  if (layout.revealed === tab) return layout;
  if (tab !== undefined) return { ...layout, revealed: tab };
  const { revealed: _revealed, ...rest } = layout;
  return rest;
}

export function withPayload(
  layout: WorkAreaLayout,
  tab: TabId,
  payload: WorkAreaTab,
): WorkAreaLayout {
  return layout.tabs[tab] === payload
    ? layout
    : { ...layout, tabs: { ...layout.tabs, [tab]: payload } };
}

/** The pane that takes the focus when the focused pane goes: its sibling's nearest leaf. */
export function focusAfterRemoval(
  root: LayoutNode,
  focused: PaneId,
  alive: ReadonlySet<PaneId>,
): PaneId | undefined {
  const path: { readonly split: SplitNode; readonly side: "first" | "second" }[] = [];
  const find = (node: LayoutNode): boolean => {
    if (node.kind === "pane") return node.id === focused;
    for (const side of ["first", "second"] as const) {
      path.push({ split: node, side });
      if (find(node[side])) return true;
      path.pop();
    }
    return false;
  };
  find(root);
  for (const { split, side } of path.toReversed()) {
    const other = leaves(side === "first" ? split.second : split.first).filter((pane) =>
      alive.has(pane.id),
    );
    const pick = side === "first" ? other[0] : other.at(-1);
    if (pick) return pick.id;
  }
  return leaves(root).find((pane) => alive.has(pane.id))?.id;
}

/** Next active tab after removals: `active` if kept, else nearest kept right, then left. */
export function nearestRemaining(
  tabs: readonly TabId[],
  active: TabId,
  removed: ReadonlySet<TabId>,
): TabId | undefined {
  const at = Math.max(0, tabs.indexOf(active));
  return [...tabs.slice(at), ...tabs.slice(0, at).toReversed()].find((tab) => !removed.has(tab));
}

/**
 * Removes tabs from every pane but `keep`; a pane that lost its active tab shows its neighbour, or
 * `restore` when it still holds it. Empty panes collapse into their sibling.
 */
export function removeTabs(
  layout: WorkAreaLayout,
  ids: ReadonlySet<TabId>,
  options: { readonly keep?: PaneId; readonly restore?: TabId } = {},
): WorkAreaLayout {
  if (ids.size === 0) return layout;
  const alive = new Set<PaneId>();
  const root = mapPanes(layout.root, (pane) => {
    if (pane.id === options.keep) {
      alive.add(pane.id);
      return pane;
    }
    const tabs = pane.tabs.filter((tab) => !ids.has(tab));
    if (tabs.length === pane.tabs.length) {
      alive.add(pane.id);
      return pane;
    }
    if (!isNonEmpty(tabs)) return null;
    alive.add(pane.id);
    const restored = options.restore !== undefined && tabs.includes(options.restore);
    const active = restored ? options.restore! : nearestRemaining(pane.tabs, pane.active, ids)!;
    return { ...pane, tabs, active };
  });
  if (root === null) {
    const fresh = defaultLayout(layout.seq);
    return { ...fresh, tabs: { ...layout.tabs, ...fresh.tabs } };
  }
  const focused = alive.has(layout.focused)
    ? layout.focused
    : (focusAfterRemoval(layout.root, layout.focused, alive) ?? leaves(root)[0]!.id);
  return { ...layout, root, focused };
}

export function insertTabs(
  pane: PaneNode,
  ids: NonEmpty<TabId>,
  before: TabId | null,
  activate: boolean,
): PaneNode {
  const rest = pane.tabs.filter((tab) => !ids.includes(tab));
  // Before a moved tab means before the first tab after it that stays.
  const anchor =
    before !== null && ids.includes(before)
      ? (pane.tabs.slice(pane.tabs.indexOf(before) + 1).find((tab) => rest.includes(tab)) ?? null)
      : before;
  const at = anchor === null ? -1 : rest.indexOf(anchor);
  const tabs = at < 0 ? [...rest, ...ids] : [...rest.slice(0, at), ...ids, ...rest.slice(at)];
  if (!isNonEmpty(tabs)) return pane;
  return {
    ...pane,
    tabs,
    active: activate || !tabs.includes(pane.active) ? ids[0] : pane.active,
  };
}

export function splitPane(
  layout: WorkAreaLayout,
  target: PaneId,
  edge: Edge,
  ids: NonEmpty<TabId>,
): { readonly layout: WorkAreaLayout; readonly pane: PaneId; readonly split: SplitId } {
  const n = layout.seq;
  const fresh: PaneNode = { kind: "pane", id: paneIdOf(n), tabs: ids, active: ids[0] };
  const axis: SplitAxis = edge === "left" || edge === "right" ? "row" : "column";
  const leading = edge === "left" || edge === "top";
  const root = mapPanes(layout.root, (pane) =>
    pane.id === target
      ? {
          kind: "split",
          id: splitIdOf(n),
          axis,
          ratio: 0.5,
          first: leading ? fresh : pane,
          second: leading ? pane : fresh,
        }
      : pane,
  );
  return {
    layout: { ...layout, root: root ?? layout.root, seq: n + 1 },
    pane: fresh.id,
    split: splitIdOf(n),
  };
}

/** The layout an older build's record implies, used when a record has none. */
export function seedWorkArea(
  record: Pick<ThreadRightPanelState, "isOpen" | "activeSurfaceId" | "surfaces">,
): WorkAreaLayout {
  const ids = record.surfaces.map((surface) => surfaceTabId(surface.id));
  if (!isNonEmpty(ids)) return DEFAULT_LAYOUT;
  const tabs = { [PRIMARY_CHAT]: PRIMARY_PAYLOAD };
  if (!record.isOpen) {
    return {
      root: { kind: "pane", id: paneIdOf(0), tabs: [PRIMARY_CHAT, ...ids], active: PRIMARY_CHAT },
      tabs,
      focused: paneIdOf(0),
      seq: 1,
    };
  }
  const active = ids.find((tab) => tab === record.activeSurfaceId) ?? ids[0];
  return {
    root: {
      kind: "split",
      id: splitIdOf(1),
      axis: "row",
      ratio: 0.5,
      first: { kind: "pane", id: paneIdOf(0), tabs: [PRIMARY_CHAT], active: PRIMARY_CHAT },
      second: { kind: "pane", id: paneIdOf(1), tabs: ids, active },
    },
    tabs,
    focused: paneIdOf(1),
    seq: 2,
  };
}

export function resolveLayout(record: ThreadRightPanelState): WorkAreaLayout {
  return record.workArea ?? seedWorkArea(record);
}

/** Whose title a Chat tab shows: none ("Chat") for a lone primary Chat, else its own thread's. */
function chatTitleThread(
  layout: WorkAreaLayout,
  tab: TabId,
  owner: ScopedThreadRef,
): ScopedThreadRef | null {
  const payload = layout.tabs[tab];
  if (payload?.kind === "secondary-chat") return payload.thread;
  return chatTabs(layout).length < 2 ? null : owner;
}

const chatEntryId = (tab: TabId): "chat" | `chat:${string}` =>
  tab === PRIMARY_CHAT ? "chat" : `chat:${tab.slice("chat:".length)}`;

/**
 * A strip's entries for `RightPanelTabs`: surfaces as stored, display-only entries for Chat and
 * linked-file tabs. Display entries never enter a record's `surfaces`.
 */
export function stripEntries(
  layout: WorkAreaLayout,
  record: ThreadRightPanelState,
  tabs: readonly TabId[],
  owner: ScopedThreadRef,
  chatLabel: string,
): WorkAreaEntry[] {
  const closable = chatTabs(layout).length > 1;
  return tabs.flatMap((tab): WorkAreaEntry[] => {
    const payload = layout.tabs[tab];
    switch (payload?.kind) {
      case "primary-chat":
      case "secondary-chat": {
        const thread = chatTitleThread(layout, tab, owner);
        return [
          {
            id: chatEntryId(tab),
            kind: "chat",
            title: chatLabel,
            closable,
            ...(thread ? { thread } : {}),
          },
        ];
      }
      case "linked-file":
        return [linkedFileEntry(tab, payload)];
      case "launcher":
        return [LAUNCHER_ENTRY];
      case "sub-thread":
        return [replyEntry(payload)];
      default:
        return record.surfaces.filter((surface) => surface.id === tab);
    }
  });
}

export type FileSurface = Extract<RightPanelSurface, { kind: "file" }>;

export type LinkedFileEntry = Omit<FileSurface, "id"> & {
  readonly id: `linked:${string}`;
  readonly source: ScopedThreadRef;
  readonly reveal: FileSurface;
};

export type ReplyEntry = {
  readonly id: `reply:${string}`;
  readonly kind: "replies";
  readonly reply: { readonly thread: ScopedThreadRef; readonly first: string };
};

type LauncherEntry = { readonly id: "launcher"; readonly kind: "launcher"; readonly title: string };

type ChatEntry = {
  readonly id: "chat" | `chat:${string}`;
  readonly kind: "chat";
  readonly title: string;
  readonly closable: boolean;
  readonly thread?: ScopedThreadRef;
};

export type DisplayEntry = ChatEntry | LauncherEntry | ReplyEntry | LinkedFileEntry;

export type WorkAreaEntry = RightPanelSurface | DisplayEntry;

// The file reader keys a reveal on this object; one per payload, so a re-render never reveals.
const linkedFileEntries = new WeakMap<LinkedFilePayload, LinkedFileEntry>();

/** A linked file's strip entry, also the surface its body reads with. */
export function linkedFileEntry(tab: TabId, payload: LinkedFilePayload): LinkedFileEntry {
  const cached = linkedFileEntries.get(payload);
  if (cached) return cached;
  const file = {
    kind: "file",
    relativePath: payload.path,
    revealLine: payload.line,
    revealRequestId: payload.reveal,
    ...(payload.attachment === undefined ? {} : { attachment: payload.attachment }),
  } as const;
  const entry: LinkedFileEntry = {
    ...file,
    id: `linked:${tab.slice("linked:".length)}`,
    source: payload.source,
    reveal: {
      ...file,
      id: payload.attachment ? `attachment:${payload.attachment.id}` : `file:${payload.path}`,
    },
  };
  linkedFileEntries.set(payload, entry);
  return entry;
}

// Keeps the cached entry: a new one would re-key the open tab's reveal and remount its view.
export function shownLinkedFile(payload: LinkedFilePayload): LinkedFilePayload {
  const next = { ...payload, shown: true } as const;
  const cached = linkedFileEntries.get(payload);
  if (cached) linkedFileEntries.set(next, cached);
  return next;
}

export const isReplyEntry = (entry: WorkAreaEntry): entry is ReplyEntry =>
  entry.kind === "replies" && "reply" in entry;

// One per payload, so the tab and its body keep their identity across renders.
const replyEntries = new WeakMap<SubThreadPayload, ReplyEntry>();

function replyEntry(payload: SubThreadPayload): ReplyEntry {
  const cached = replyEntries.get(payload);
  if (cached) return cached;
  const entry: ReplyEntry = {
    id: replyKey(payload.thread, payload.first),
    kind: "replies",
    reply: { thread: payload.thread, first: payload.first },
  };
  replyEntries.set(payload, entry);
  return entry;
}

const LAUNCHER_ENTRY: LauncherEntry = {
  id: "launcher",
  kind: "launcher",
  title: WORK_AREA_COPY.newTab,
};

/** A strip entry that `updateWorkArea` activates and closes, not the surface close path. */
export const isDisplayEntry = (entry: WorkAreaEntry): entry is DisplayEntry =>
  entry.kind === "chat" || entry.kind === "launcher" || isReplyEntry(entry) || "source" in entry;

// A focused workspace file, linked from another thread or not, takes the header's Open in chord.
export function openInFileTab(record: ThreadRightPanelState): TabId | null {
  const layout = resolveLayout(record);
  const tab = focusedTab(layout);
  const payload = layout.tabs[tab];
  if (payload?.kind === "linked-file") return payload.attachment === undefined ? tab : null;
  const surface = record.surfaces.find((entry) => surfaceTabId(entry.id) === tab);
  return surface?.kind === "file" && surface.attachment === undefined ? tab : null;
}

export function focusedTab(layout: WorkAreaLayout): TabId {
  return (findPane(layout.root, layout.focused) ?? leaves(layout.root)[0]!).active;
}
