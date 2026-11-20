import {
  type Announcements,
  type CollisionDetection,
  DndContext,
  DragOverlay,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import type { EditorId, ScopedThreadRef } from "@t3tools/contracts";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { RightPanelTabs, type RightPanelTabsProps } from "~/components/RightPanelTabs";
import { chatSurfaceAction } from "~/fork/dashboard/dashboardSurface";
import { WORK_AREA_COPY } from "~/fork/forkCopy";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { requestWorkspaceFocus } from "~/lib/workspaceFocus";
import { setActivePreviewTab } from "~/previewStateStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import {
  type RightPanelKind,
  type RightPanelSurface,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";
import { readThreadShell } from "~/state/entities";

import {
  type Box,
  type DragSubject,
  type DropGhost,
  type DropPlan,
  inStripView,
  type PaneGeometry,
  planDrop,
  samePlan,
} from "./dropPlan.logic";
import { OpenOriginContext } from "./chatFileOpener";
import { LinkedFileBody } from "./LinkedFileBody";
import { SecondaryChat } from "./SecondaryChat";
import { RightPanelPaneContext, type RightPanelTabMenu, useTabDragSensors } from "./tabStrip";
import { dragShieldProps, registerThreadDragFallback } from "./threadDragFallback";
import {
  isDisplayEntry,
  linkedFileEntry,
  paneHolding,
  type PaneId,
  PRIMARY_CHAT,
  resolveLayout,
  type SplitAxis,
  type SplitId,
  stripEntries,
  surfaceTabId,
  type TabId,
  type WorkAreaLayout,
  type WorkAreaTab,
} from "./workArea.logic";
import {
  canSplit,
  chatColumnBox,
  type DrawnDivider,
  type DrawnPane,
  drawWorkArea,
  isStripView,
  primaryChatRect,
  ratioBounds,
  splitVariable,
  splitVariables,
} from "./workAreaGeometry.logic";
import type { WorkAreaChange } from "./workAreaPlacement.logic";
import {
  currentWorkAreaView,
  drawModeView,
  publishWorkAreaView,
  useStripView,
  WORK_AREA_LAYOUT_EVENT,
} from "./workAreaView";

type PaneTabsProps = Omit<
  RightPanelTabsProps,
  | "children"
  | "mode"
  | "maximized"
  | "open"
  | "widthStorageKey"
  | "defaultWidth"
  | "inlineSize"
  | "layoutControls"
  | "surfaces"
  | "activeSurfaceId"
  | "onMoveSurface"
>;

type WorkAreaProps = PaneTabsProps & {
  readonly threadRef: ScopedThreadRef;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly renderSurface: (surface: RightPanelSurface, visible: boolean) => ReactNode;
};

type Point = { readonly x: number; readonly y: number };

const UNFOCUSED_PANE_CLASS =
  "[&_[data-right-panel-tabbar]_[data-active-tab=true]]:text-muted-foreground";
const KEYBOARD_STEP = 16;
const THREADS: DragSubject = { kind: "threads" };
// Drops are planned from measured panes, not from dnd-kit's droppables.
const NO_COLLISIONS: CollisionDetection = () => [];
// Tabs drag only with a move handler; `onDragEnd` places their drops, in the strip view too.
const ignoreMove = () => {};

const AUTO_SCROLL = {
  canScroll: (element: Element) =>
    element.matches('[data-slot="scroll-area-viewport"]') &&
    element.closest("[data-right-panel-tab-list]") !== null,
};

function titleOf(data: Readonly<Record<string, unknown>> | undefined): string {
  const title = data?.title;
  return typeof title === "string" ? title : "Tab";
}

const ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => `Picked up ${titleOf(active.data.current)}.`,
  onDragOver: () => undefined,
  onDragEnd: ({ active }) => `${titleOf(active.data.current)} was dropped.`,
  onDragCancel: ({ active }) => `Moving ${titleOf(active.data.current)} was cancelled.`,
};

// A DOMRect's edges are prototype getters, which a spread would drop.
const boxOf = (element: Element): Box => {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { left, top, right, bottom };
};

const chatColumnOf = (root: HTMLElement) =>
  root.parentElement?.querySelector<HTMLElement>(":scope > [data-chat-column]") ?? null;

function focusChatComposer(payload: WorkAreaTab | undefined) {
  if (payload?.kind === "secondary-chat") {
    requestWorkspaceFocus({
      area: "panel",
      selector: `[data-side-chat-pane="${CSS.escape(payload.thread.threadId)}"] [data-workspace-area="composer"] [contenteditable="true"]`,
    });
  } else if (payload?.kind === "primary-chat") {
    requestWorkspaceFocus({
      area: "composer",
      selector: '[contenteditable="true"]:not([data-side-chat-pane] *)',
    });
  }
}

/**
 * Everything right of the thread list: the shown thread's panes, each a tab strip over its active
 * tab. ChatView's chat column stays in ChatView and is drawn over the primary Chat tab's body.
 */
export function WorkArea(props: WorkAreaProps) {
  const { threadRef, renderSurface, availableEditors, ...tabs } = props;
  const record = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  const layout = resolveLayout(record);
  const strip = useStripView(layout);
  const drawn = drawWorkArea(layout, drawModeView(strip));
  const narrow = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const rootRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ readonly tab: TabId; readonly restore: TabId | undefined } | null>(null);
  // The pointer itself: a drag event's delta also counts the tab strip's auto-scroll.
  const pointer = useRef<Point | null>(null);
  const followingPointer = useRef<AbortController | null>(null);
  const [tabDrag, setTabDrag] = useState<{ title: string; plan: DropPlan | null } | null>(null);
  const [threadDrag, setThreadDrag] = useState<{ plan: DropPlan | null } | null>(null);
  const sensors = useTabDragSensors();

  const readLayout = () =>
    resolveLayout(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
    );

  const update = useStableCallback((change: WorkAreaChange) => {
    const store = useRightPanelStore.getState();
    store.updateWorkArea(threadRef, change);
    if (change.type === "ratio" || change.type === "arm") return;
    const focused = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      threadRef,
    );
    if (focused?.kind === "preview" && focused.resourceId) {
      setActivePreviewTab(threadRef, focused.resourceId);
    }
  });

  const notePress = useStableCallback((surfaceId: string) => {
    const tab = surfaceTabId(surfaceId);
    const shown = paneHolding(readLayout().root, tab)?.active;
    press.current = { tab, restore: shown === tab ? undefined : shown };
  });

  const measure = (current: WorkAreaLayout): PaneGeometry[] => {
    const root = rootRef.current;
    if (!root) return [];
    return drawWorkArea(current, currentWorkAreaView()).panes.flatMap((pane) => {
      const frame = root.querySelector<HTMLElement>(
        `[data-work-area-pane="${CSS.escape(pane.id)}"]`,
      );
      const stripElement = frame?.querySelector<HTMLElement>("[data-right-panel-tabbar]");
      if (!frame || !stripElement) return [];
      return [
        {
          id: pane.id,
          frame: boxOf(frame),
          strip: boxOf(stripElement),
          tabs: pane.tabs.flatMap((tab) => {
            const element = stripElement.querySelector<HTMLElement>(
              `[data-tab-id="${CSS.escape(tab)}"]`,
            );
            return element ? [{ id: tab, box: boxOf(element) }] : [];
          }),
        },
      ];
    });
  };

  const planAt = (point: Point, subject: DragSubject): DropPlan | null => {
    const current = readLayout();
    const view = currentWorkAreaView();
    const plan = planDrop(
      measure(current),
      point,
      subject,
      (pane: PaneId, axis: SplitAxis) => canSplit(current, view, pane, axis) === true,
    );
    return isStripView(current, view) ? inStripView(plan, current.root) : plan;
  };

  const tabPlan = (id: UniqueIdentifier): DropPlan | null => {
    const point = pointer.current;
    const tab = surfaceTabId(String(id));
    const current = readLayout();
    // In the strip view the one strip is the source pane, so a drop that keeps the order is none.
    const from = drawWorkArea(current, currentWorkAreaView()).panes.find((pane) =>
      pane.tabs.includes(tab),
    );
    if (!point || !from) return null;
    return planAt(point, { kind: "tab", tab, from: from.id });
  };

  const followPointer = () => {
    const controller = new AbortController();
    const follow = (event: PointerEvent | TouchEvent) => {
      const at = "touches" in event ? event.touches[0] : event;
      if (at) pointer.current = { x: at.clientX, y: at.clientY };
    };
    window.addEventListener("pointermove", follow, { capture: true, signal: controller.signal });
    window.addEventListener("touchmove", follow, { capture: true, signal: controller.signal });
    followingPointer.current = controller;
  };

  const finishTabDrag = () => {
    followingPointer.current?.abort();
    followingPointer.current = null;
    press.current = null;
    pointer.current = null;
    setTabDrag(null);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a tab drag that an unmount cuts short stops following the window's pointer
  useEffect(() => () => followingPointer.current?.abort(), []);

  const moveThreadDrag = useStableCallback((point: Point | null) => {
    const plan = point ? planAt(point, THREADS) : null;
    setThreadDrag((current) =>
      current !== null && samePlan(current.plan, plan) ? current : { plan },
    );
  });
  const dropThreads = useStableCallback((point: Point, threads: ReadonlyArray<ScopedThreadRef>) => {
    setThreadDrag(null);
    const placeable = threads.filter((thread) => readThreadShell(thread) !== null);
    const plan = planAt(point, THREADS);
    if (!plan || placeable.length === 0) return false;
    update({ type: "place", source: { threads: placeable }, at: plan.at });
    return true;
  });
  const endThreadDrag = useStableCallback(() => setThreadDrag(null));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- thread drags start in the sidebar, outside this tree; drops that miss every composer come here
  useEffect(
    () =>
      registerThreadDragFallback({ move: moveThreadDrag, drop: dropThreads, end: endThreadDrag }),
    [moveThreadDrag, dropThreads, endThreadDrag],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the work area's size to store writes outside React, which place tabs by fit
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let unpublish = () => {};
    const publish = () => {
      const { clientWidth: width, clientHeight: height } = root;
      // A work area with no layout yet (hidden, or its container unsized) has no fit data.
      const size = width > 0 && height > 0 ? { width, height } : null;
      unpublish = publishWorkAreaView({ narrow, size });
    };
    publish();
    const stopObserving = observeResize(root, publish);
    return () => {
      stopObserving();
      unpublish();
    };
  }, [narrow]);

  const geometryKey = JSON.stringify(drawn.panes.map((pane) => [pane.id, pane.rect]));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- desktop browser views live outside the DOM and re-place when a pane moves without resizing
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent(WORK_AREA_LAYOUT_EVENT, { detail: geometryKey }));
  }, [geometryKey]);

  const focusChatPane = useStableCallback(() => {
    const current = readLayout();
    const pane = paneHolding(current.root, PRIMARY_CHAT);
    if (pane && pane.active === PRIMARY_CHAT && pane.id !== current.focused) {
      update({ type: "focus", pane: pane.id });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ChatView's chat column is outside this tree; its presses and keyboard moves focus the primary Chat's pane
  useEffect(() => {
    const root = rootRef.current;
    const column = root && chatColumnOf(root);
    if (!root || !column) return;
    // The pane rule: the primary button, and thumb buttons so back and forward reach this pane.
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 0 || event.button === 3 || event.button === 4) focusChatPane();
    };
    // Focus from a pane is a keyboard move; the app's own composer focus leaves the panes alone.
    const onFocusIn = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget))
        focusChatPane();
    };
    column.addEventListener("pointerdown", onPointerDown, true);
    column.addEventListener("keydown", focusChatPane, true);
    column.addEventListener("focusin", onFocusIn);
    return () => {
      column.removeEventListener("pointerdown", onPointerDown, true);
      column.removeEventListener("keydown", focusChatPane, true);
      column.removeEventListener("focusin", onFocusIn);
    };
  }, [focusChatPane]);

  const focusBrowserPane = useStableCallback((tabId: string) => {
    const current = readLayout();
    const pane = drawWorkArea(current, currentWorkAreaView()).panes.find(
      (candidate) => candidate.active === surfaceTabId(`browser:${tabId}`),
    );
    if (pane && pane.id !== current.focused) update({ type: "focus", pane: pane.id });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- desktop browser views live outside the DOM; the desktop replays a press in one as a pointerdown on its webview
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.localName !== "webview") return;
      const tabId = target.dataset.previewServerTab;
      if (tabId) focusBrowserPane(tabId);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [focusBrowserPane]);

  const previewRatio = (override: { readonly split: SplitId; readonly ratio: number }) => {
    const root = rootRef.current;
    const column = root && chatColumnOf(root);
    const rect = primaryChatRect(readLayout(), currentWorkAreaView(), override);
    if (column && rect) Object.assign(column.style, chatColumnBox(rect));
    window.dispatchEvent(new CustomEvent(WORK_AREA_LAYOUT_EVENT, { detail: override }));
  };

  const shieldUp = tabDrag !== null || threadDrag !== null;
  const ghost = (tabDrag ?? threadDrag)?.plan?.ghost ?? null;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={NO_COLLISIONS}
      autoScroll={AUTO_SCROLL}
      accessibility={{ announcements: ANNOUNCEMENTS }}
      onDragStart={({ active, activatorEvent }) => {
        // A touch drag starts without a press activation, so an older press record is stale.
        const pressed =
          activatorEvent instanceof PointerEvent && activatorEvent.pointerType !== "touch";
        if (!pressed || press.current?.tab !== active.id) press.current = null;
        followPointer();
        setTabDrag({ title: titleOf(active.data.current), plan: null });
      }}
      onDragMove={({ active }) => {
        const plan = tabPlan(active.id);
        setTabDrag((current) =>
          current === null || samePlan(current.plan, plan) ? current : { ...current, plan },
        );
      }}
      onDragEnd={({ active }) => {
        const tab = surfaceTabId(String(active.id));
        const plan = tabPlan(active.id);
        const restore = press.current?.tab === tab ? press.current.restore : undefined;
        finishTabDrag();
        if (!plan) return;
        update({
          type: "place",
          source: { tabs: [tab] },
          at: plan.at,
          ...(restore === undefined ? {} : { restore }),
        });
      }}
      onDragCancel={finishTabDrag}
    >
      <div
        ref={rootRef}
        data-work-area
        className="absolute inset-0 overflow-hidden"
        style={splitVariables(layout.root) as CSSProperties}
      >
        {drawn.panes.map((pane) => (
          <WorkAreaPane
            key={strip ? "strip" : pane.id}
            pane={pane}
            layout={layout}
            record={record}
            strip={strip}
            threadRef={threadRef}
            tabs={tabs}
            availableEditors={availableEditors}
            renderSurface={renderSurface}
            update={update}
            notePress={notePress}
          />
        ))}
        {drawn.dividers.map((divider) => (
          <WorkAreaDivider
            key={divider.split.id}
            divider={divider}
            rootRef={rootRef}
            onPreview={previewRatio}
            onCommit={(ratio) => update({ type: "ratio", split: divider.split.id, ratio })}
          />
        ))}
      </div>
      {createPortal(
        <>
          <DragOverlay dropAnimation={null} zIndex={60}>
            {tabDrag ? (
              <div className="flex h-6 max-w-36 items-center rounded-md bg-accent px-2 text-xs text-foreground shadow-md">
                <span className="truncate">{tabDrag.title}</span>
              </div>
            ) : null}
          </DragOverlay>
          {/* Code views and hosted browser pages under the pointer must not see the drag. */}
          {shieldUp ? (
            <div
              aria-hidden
              {...dragShieldProps()}
              className="fixed inset-0 z-40 cursor-grabbing"
            />
          ) : null}
          {ghost ? <DropGhostView ghost={ghost} /> : null}
        </>,
        document.body,
      )}
    </DndContext>
  );
}

function WorkAreaPane(props: {
  readonly pane: DrawnPane;
  readonly layout: WorkAreaLayout;
  readonly record: ThreadRightPanelState;
  readonly strip: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly tabs: PaneTabsProps;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly renderSurface: WorkAreaProps["renderSurface"];
  readonly update: (change: WorkAreaChange) => void;
  readonly notePress: (surfaceId: string) => void;
}) {
  const { pane, layout, threadRef, tabs, update } = props;
  const entries = stripEntries(layout, props.record, pane.tabs, threadRef, WORK_AREA_COPY.chat);
  const tabOf = (entry: RightPanelSurface) => surfaceTabId(entry.id);
  // Bulk closes never close a Chat; linked files close once the surfaces' close path confirms.
  const closeEntries = (closing: readonly RightPanelSurface[]) => {
    const closeLinked = () => {
      for (const entry of closing) {
        if (entry.kind === "file" && entry.source) update({ type: "close", tab: tabOf(entry) });
      }
    };
    const surfaces = closing.filter((entry) => !isDisplayEntry(entry));
    if (surfaces.length > 0) tabs.onCloseAllSurfaces(surfaces, closeLinked);
    else closeLinked();
  };
  const arm = (kind: RightPanelKind) => update({ type: "arm", pane: pane.id, kind });
  const armed = (kind: RightPanelKind, open: () => void) => () => {
    arm(kind);
    open();
  };
  const splitDisabled = (entry: RightPanelSurface, axis: SplitAxis) => {
    const holder = paneHolding(layout.root, tabOf(entry));
    return (
      props.strip ||
      !holder ||
      holder.tabs.length < 2 ||
      canSplit(layout, currentWorkAreaView(), holder.id, axis) !== true
    );
  };
  const tabMenu: RightPanelTabMenu = {
    items: (entry) => [
      {
        id: "split-right",
        label: WORK_AREA_COPY.splitRight,
        disabled: splitDisabled(entry, "row"),
      },
      {
        id: "split-down",
        label: WORK_AREA_COPY.splitDown,
        disabled: splitDisabled(entry, "column"),
      },
    ],
    select: (action, entry) => {
      const holder = paneHolding(layout.root, tabOf(entry));
      if (!holder) return;
      update({
        type: "place",
        source: { tabs: [tabOf(entry)] },
        at: { kind: "edge", pane: holder.id, edge: action === "split-right" ? "right" : "bottom" },
      });
    },
  };
  const modeSurfaceActions = [
    ...(tabs.modeSurfaceActions ?? []).map((action) => ({
      ...action,
      onClick: armed(action.id, action.onClick),
    })),
    ...(paneHolding(layout.root, PRIMARY_CHAT) === undefined
      ? [
          chatSurfaceAction(() =>
            update({
              type: "place",
              source: { threads: [threadRef] },
              at: { kind: "join", pane: pane.id },
            }),
          ),
        ]
      : []),
  ];
  const payload = layout.tabs[pane.active];
  const activeEntry = entries.find((entry) => entry.id === pane.active);
  const body =
    payload?.kind === "primary-chat" ? (
      <div data-chat-tab-slot className="min-h-0 flex-1" />
    ) : payload?.kind === "secondary-chat" ? (
      <SecondaryChat
        key={pane.active}
        thread={payload.thread}
        owner={threadRef}
        tab={pane.active}
        placement={payload.placement}
      />
    ) : payload?.kind === "linked-file" ? (
      <LinkedFileBody
        owner={threadRef}
        tab={pane.active}
        entry={linkedFileEntry(pane.active, payload)}
        keybindings={tabs.keybindings}
        availableEditors={props.availableEditors}
      />
    ) : activeEntry ? (
      props.renderSurface(activeEntry, true)
    ) : null;
  return (
    <div
      data-work-area-pane={pane.id}
      className={cn(
        "absolute flex min-h-0 min-w-0 flex-col",
        !pane.focused && UNFOCUSED_PANE_CLASS,
      )}
      style={pane.box}
      onPointerDownCapture={(event) => {
        // A tab press activates its tab, which focuses the pane itself.
        if (pane.focused) return;
        if (event.target instanceof Element && event.target.closest("[data-active-tab]")) return;
        if (event.button === 0 || event.button === 3 || event.button === 4) {
          update({ type: "focus", pane: pane.id });
        }
      }}
      onFocusCapture={() => {
        if (!pane.focused) update({ type: "focus", pane: pane.id });
      }}
    >
      <RightPanelPaneContext
        value={{
          id: pane.id,
          edges: pane.edges,
          focused: pane.focused,
          tabMenu,
          notePress: props.notePress,
        }}
      >
        <RightPanelTabs
          {...tabs}
          mode="inline"
          surfaces={entries}
          activeSurfaceId={pane.active}
          onMoveSurface={ignoreMove}
          onActivate={(entry) => {
            if (!isDisplayEntry(entry)) {
              tabs.onActivate(entry);
              return;
            }
            update({ type: "activate", tab: tabOf(entry) });
            focusChatComposer(layout.tabs[tabOf(entry)]);
          }}
          onCloseSurface={(entry) =>
            isDisplayEntry(entry)
              ? update({ type: "close", tab: tabOf(entry) })
              : tabs.onCloseSurface(entry)
          }
          onCloseOtherSurfaces={(entry, strip) =>
            closeEntries(strip.filter((other) => other.id !== entry.id))
          }
          onCloseSurfacesToRight={(entry, strip) => {
            const index = strip.findIndex((other) => other.id === entry.id);
            if (index >= 0) closeEntries(strip.slice(index + 1));
          }}
          onCloseAllSurfaces={closeEntries}
          onAddBrowser={armed("preview", tabs.onAddBrowser)}
          onAddBrowserInProfile={(profileId) => {
            arm("preview");
            tabs.onAddBrowserInProfile(profileId);
          }}
          onAddTerminal={armed("terminal", tabs.onAddTerminal)}
          onAddDiff={armed("diff", tabs.onAddDiff)}
          onAddFiles={armed("files", tabs.onAddFiles)}
          onAddPullRequest={armed("pull-request", tabs.onAddPullRequest)}
          onAddPullRequests={armed("pull-requests", tabs.onAddPullRequests)}
          onAddDevice={armed("device", tabs.onAddDevice)}
          onAddSideChat={tabs.onAddSideChat ? armed("side-chat", tabs.onAddSideChat) : undefined}
          modeSurfaceActions={modeSurfaceActions}
        >
          <OpenOriginContext value={null}>{body}</OpenOriginContext>
        </RightPanelTabs>
      </RightPanelPaneContext>
    </div>
  );
}

function WorkAreaDivider(props: {
  readonly divider: DrawnDivider;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly onPreview: (override: { readonly split: SplitId; readonly ratio: number }) => void;
  readonly onCommit: (ratio: number) => void;
}) {
  const { divider, rootRef, onPreview, onCommit } = props;
  const { split, parent } = divider;
  const row = split.axis === "row";
  const measure = () => {
    const root = rootRef.current;
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    const total = row ? parent.w * rect.width : parent.h * rect.height;
    if (total <= 0) return null;
    return {
      root,
      total,
      origin: row ? rect.left + parent.x * rect.width : rect.top + parent.y * rect.height,
      bounds: ratioBounds(divider, { width: rect.width, height: rect.height }),
    };
  };
  const clamp = (ratio: number, bounds: { readonly min: number; readonly max: number }) =>
    Math.min(bounds.max, Math.max(bounds.min, ratio));
  const show = (root: HTMLElement, ratio: number) => {
    root.style.setProperty(splitVariable(split.id), String(ratio));
    onPreview({ split: split.id, ratio });
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const measured = measure();
    if (!measured || measured.bounds.max < measured.bounds.min) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let ratio = split.ratio;
    let moved = false;
    const onMove = (move: PointerEvent) => {
      const position = row ? move.clientX : move.clientY;
      ratio = clamp((position - measured.origin) / measured.total, measured.bounds);
      moved = true;
      show(measured.root, ratio);
    };
    const finish = (commit: boolean) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      handle.removeEventListener("lostpointercapture", onCancel);
      if (commit && moved) onCommit(ratio);
      else show(measured.root, split.ratio);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    handle.addEventListener("lostpointercapture", onCancel);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const measured = measure();
    if (!measured) return;
    const step = KEYBOARD_STEP / measured.total;
    const next =
      event.key === (row ? "ArrowLeft" : "ArrowUp")
        ? split.ratio - step
        : event.key === (row ? "ArrowRight" : "ArrowDown")
          ? split.ratio + step
          : event.key === "Home"
            ? measured.bounds.min
            : event.key === "End"
              ? measured.bounds.max
              : event.key === "Enter"
                ? 0.5
                : null;
    if (next === null) return;
    event.preventDefault();
    onCommit(clamp(next, measured.bounds));
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={WORK_AREA_COPY.resizePanes}
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(split.ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      data-work-area-divider={split.id}
      className="absolute z-[2] bg-border outline-none [-webkit-app-region:no-drag] focus-visible:bg-ring"
      style={divider.box}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        const measured = measure();
        if (measured) onCommit(clamp(0.5, measured.bounds));
      }}
    >
      <div
        aria-hidden
        className={cn(
          "absolute",
          row
            ? "inset-y-0 -right-1 -left-1 cursor-col-resize"
            : "inset-x-0 -top-1 -bottom-1 cursor-row-resize",
        )}
      />
    </div>
  );
}

function DropGhostView({ ghost }: { readonly ghost: DropGhost }) {
  if (ghost.kind === "marker") {
    return (
      <div
        aria-hidden
        data-work-area-drop-ghost="marker"
        className="pointer-events-none fixed z-[70] w-0.5 rounded-full bg-primary"
        style={{ left: ghost.left, top: ghost.top, height: ghost.height }}
      />
    );
  }
  return (
    <div
      aria-hidden
      data-work-area-drop-ghost="box"
      className="pointer-events-none fixed z-50 rounded-md bg-primary/15 ring-2 ring-primary/45 ring-inset"
      style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height }}
    />
  );
}
