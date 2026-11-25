import {
  type Announcements,
  type CollisionDetection,
  DndContext,
  DragOverlay,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
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
import { PanelRightIcon } from "lucide-react";
import { createPortal } from "react-dom";

import "./workArea.css";

import { RightPanelTabs, type RightPanelTabsProps } from "~/components/RightPanelTabs";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
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
  type RightPanelSurface,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  type ThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import {
  type Box,
  type DragSubject,
  type DropFits,
  type DropGhost,
  type DropPlan,
  inStripView,
  type PaneGeometry,
  planDrop,
  samePlan,
} from "./dropPlan.logic";
import { focusReplyBox } from "./chatFileOpener";
import { placeableInWorkArea } from "./chatOpenerContext";
import { ChatOpenScope } from "./ChatOpenScope";
import { followDrawerTerminals, useAdoptServerTerminals } from "./drawerTerminals";
import { LinkedFileBody } from "./LinkedFileBody";
import { LINK_PROBE, probeLayout } from "./linkDrop.logic";
import { filesTreeOwner } from "./linkSources";
import { PanelLinkOwnerContext } from "./panelLinkDrag";
import { SecondaryChat } from "./SecondaryChat";
import {
  ReplyTabContext,
  RightPanelPaneContext,
  type RightPanelTabMenu,
  useTabDragSensors,
} from "./tabStrip";
import { dragShieldProps, registerThreadDragFallback } from "./threadDragFallback";
import { useLinkDrops } from "./useLinkDrops";
import { followFindRequests } from "./useWorkAreaChat";
import { viewScope } from "./viewReading";
import {
  type ArmKind,
  type Edge,
  findPane,
  gestureViews,
  isDisplayEntry,
  isPlaced,
  isReplyEntry,
  LAUNCHER,
  linkedFileEntry,
  parseViewKey,
  preferredView,
  PRIMARY_CHAT,
  replyTabId,
  resolveLayout,
  type SplitId,
  stripEntries,
  surfaceTabId,
  type TabId,
  type ViewRef,
  viewKey,
  viewsOf,
  type WorkAreaEntry,
  type WorkAreaLayout,
  type WorkAreaTab,
} from "./workArea.logic";
import {
  chatColumnBox,
  type DrawnDivider,
  type DrawnPane,
  drawWorkArea,
  isStripView,
  primaryChatRect,
  ratioBounds,
  type Rect,
  splitVariable,
  splitVariables,
} from "./workAreaGeometry.logic";
import { closeTab, closeViews, openFromPaneMenu, runOpen } from "./workAreaCommands";
import {
  landingRect,
  moveToward,
  type PlaceSource,
  type WorkAreaChange,
} from "./workAreaPlacement.logic";
import {
  currentDropAt,
  currentWorkAreaView,
  drawModeView,
  publishWorkAreaView,
  useStripView,
  useWorkAreaViewCheck,
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
  | "launcher"
  | "surfaces"
  | "activeSurfaceId"
  | "onMoveSurface"
>;

type WorkAreaProps = PaneTabsProps & {
  readonly threadRef: ScopedThreadRef;
  /** The primary Chat's own controls, at the end of the bar of the pane that shows it. */
  readonly chatControls?: ReactNode;
  readonly availableEditors: ReadonlyArray<EditorId>;
  /**
   * Renders a surface body. When `onClose` is given, in-body close controls call it so closing
   * removes only this pane's view while another view stays open.
   */
  readonly renderSurface: (
    surface: RightPanelSurface,
    visible: boolean,
    onClose?: (surface: RightPanelSurface) => void,
  ) => ReactNode;
};

type Point = { readonly x: number; readonly y: number };

// ChatView imports this module statically, so the drawer never draws before this runs.
followDrawerTerminals();
followFindRequests();

const REPLIES_SURFACE: RightPanelSurface = { id: "replies", kind: "replies" };

const UNFOCUSED_PANE_CLASS =
  "[&_[data-right-panel-tabbar]_[data-active-tab=true]]:text-muted-foreground";
const KEYBOARD_STEP = 16;
const MOVE_ITEMS: readonly { readonly edge: Edge; readonly label: string }[] = [
  { edge: "left", label: WORK_AREA_COPY.moveLeft },
  { edge: "right", label: WORK_AREA_COPY.moveRight },
  { edge: "top", label: WORK_AREA_COPY.moveUp },
  { edge: "bottom", label: WORK_AREA_COPY.moveDown },
];
const OUTSIDE: DragSubject = { kind: "outside" };
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
  } else if (payload?.kind === "sub-thread") {
    focusReplyBox(replyTabId(payload.thread, payload.first));
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
  const { threadRef, renderSurface, availableEditors, chatControls, ...tabs } = props;
  const record = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  const layout = resolveLayout(record);
  const strip = useStripView(layout);
  const drawn = drawWorkArea(layout, drawModeView(strip));
  const narrow = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const rootRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ readonly view: ViewRef; readonly restore: TabId | undefined } | null>(
    null,
  );
  // The pointer itself: a drag event's delta also counts the tab strip's auto-scroll.
  const pointer = useRef<Point | null>(null);
  // Alt held at the pointer's last event: a tab drag then copies a many-view tab.
  const alt = useRef(false);
  const followingPointer = useRef<AbortController | null>(null);
  const [tabDrag, setTabDrag] = useState<{ title: string; plan: DropPlan | null } | null>(null);
  const [threadDrag, setThreadDrag] = useState<{ plan: DropPlan | null } | null>(null);
  const [linkPlan, setLinkPlan] = useState<DropPlan | null>(null);
  const sensors = useTabDragSensors();
  useAdoptServerTerminals(threadRef);

  const readRecord = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
  const readLayout = () => resolveLayout(readRecord());

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

  const notePress = useStableCallback((view: ViewRef) => {
    const shown = findPane(readLayout().root, view.pane)?.active;
    press.current = { view, restore: shown === view.tab ? undefined : shown };
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
              `[data-right-panel-tab-id="${CSS.escape(tab)}"]`,
            );
            return element ? [{ id: tab, box: boxOf(element) }] : [];
          }),
        },
      ];
    });
  };

  const planAt = (
    point: Point,
    subject: DragSubject,
    source: PlaceSource,
    current = readLayout(),
  ): DropPlan | null => {
    const view = currentWorkAreaView();
    const root = rootRef.current;
    if (!root) return null;
    const area = boxOf(root);
    const inArea = (rect: Rect): Box => ({
      left: area.left + rect.x * (area.right - area.left),
      top: area.top + rect.y * (area.bottom - area.top),
      right: area.left + (rect.x + rect.w) * (area.right - area.left),
      bottom: area.top + (rect.y + rect.h) * (area.bottom - area.top),
    });
    // The one strip already does not fit; its drops only reorder or join.
    const strip = isStripView(current, view);
    const fits: DropFits = (pane, at) => {
      if (strip) return at === "join" ? area : null;
      const rect = landingRect(
        current,
        {
          type: "place",
          source,
          at: at === "join" ? { kind: "join", pane } : { kind: "edge", pane, edge: at },
        },
        threadRef,
        readRecord().surfaces,
        view,
      );
      return rect && inArea(rect);
    };
    const plan = planDrop(measure(current), point, subject, fits);
    return strip ? inStripView(plan, current.root) : plan;
  };

  // A drag of `view` with Alt held copies it, when its tab may have several views; the one strip
  // lists tabs, so there it moves.
  const copies = (view: ViewRef): boolean => {
    const current = readLayout();
    return (
      alt.current &&
      !isStripView(current, currentWorkAreaView()) &&
      viewsOf(current, readRecord().surfaces, view.tab) === "many"
    );
  };

  const tabPlan = (id: UniqueIdentifier): DropPlan | null => {
    const point = pointer.current;
    const view = parseViewKey(String(id));
    const current = readLayout();
    // In the strip view the one strip is the source pane, so a drop that keeps the order is none.
    const panes = drawWorkArea(current, currentWorkAreaView()).panes;
    const from =
      view &&
      (panes.find((pane) => pane.id === view.pane && pane.tabs.includes(view.tab)) ??
        panes.find((pane) => pane.tabs.includes(view.tab)));
    if (!point || !view || !from) return null;
    const copy = copies(view);
    return planAt(
      point,
      { kind: "tab", tab: view.tab, from: from.id, ...(copy ? { copy } : {}) },
      { view, ...(copy ? { copy } : {}) },
    );
  };

  const followPointer = (activator: Event) => {
    const controller = new AbortController();
    const follow = (event: PointerEvent | TouchEvent) => {
      alt.current = event.altKey;
      const at = "touches" in event ? event.touches[0] : event;
      if (at) pointer.current = { x: at.clientX, y: at.clientY };
    };
    window.addEventListener("pointermove", follow, { capture: true, signal: controller.signal });
    window.addEventListener("touchmove", follow, { capture: true, signal: controller.signal });
    // PointerSensor starts a drag on the move past its distance threshold, so a single-move drag
    // fires no later pointermove; seed from the activator event and track pointerup too.
    if (activator instanceof PointerEvent) {
      follow(activator);
      const release = (event: PointerEvent) => {
        if (event.pointerId === activator.pointerId) follow(event);
      };
      window.addEventListener("pointerup", release, { capture: true, signal: controller.signal });
    }
    followingPointer.current = controller;
  };

  const finishTabDrag = () => {
    followingPointer.current?.abort();
    followingPointer.current = null;
    press.current = null;
    pointer.current = null;
    alt.current = false;
    setTabDrag(null);
  };

  const moveThreadDrag = useStableCallback(
    (point: Point | null, threads: ReadonlyArray<ScopedThreadRef>) => {
      const placeable = threads.filter((thread) => placeableInWorkArea(threadRef, thread));
      const plan =
        point && placeable.length > 0 ? planAt(point, OUTSIDE, { threads: placeable }) : null;
      setThreadDrag((current) =>
        current !== null && samePlan(current.plan, plan) ? current : { plan },
      );
    },
  );
  const dropThreads = useStableCallback((point: Point, threads: ReadonlyArray<ScopedThreadRef>) => {
    setThreadDrag(null);
    const placeable = threads.filter((thread) => placeableInWorkArea(threadRef, thread));
    const plan = planAt(point, OUTSIDE, { threads: placeable });
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

  useLinkDrops({
    owner: threadRef,
    planAt: (point, link) =>
      planAt(point, OUTSIDE, { tabs: [LINK_PROBE] }, probeLayout(readLayout(), threadRef, link)),
    show: (plan) => setLinkPlan((current) => (samePlan(current, plan) ? current : plan)),
    open: (link, at, live) => runOpen({ record: threadRef, drop: { at, live } }, () => link.open()),
  });

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

  /** Draws a divider drag's ratio before it commits, or with none, the store's ratios again. */
  const previewRatio = (override?: { readonly split: SplitId; readonly ratio: number }) => {
    const root = rootRef.current;
    const current = readLayout();
    if (root && override === undefined) {
      for (const [name, value] of Object.entries(splitVariables(current.root))) {
        root.style.setProperty(name, value);
      }
    }
    const column = root && chatColumnOf(root);
    const rect = primaryChatRect(current, currentWorkAreaView(), override);
    if (column && rect) Object.assign(column.style, chatColumnBox(rect));
    window.dispatchEvent(new CustomEvent(WORK_AREA_LAYOUT_EVENT, { detail: override }));
  };

  const shieldUp = tabDrag !== null || threadDrag !== null;
  const ghost = ((tabDrag ?? threadDrag)?.plan ?? linkPlan)?.ghost ?? null;
  return (
    <PanelLinkOwnerContext value={filesTreeOwner(threadRef)}>
      <DndContext
        sensors={sensors}
        collisionDetection={NO_COLLISIONS}
        autoScroll={AUTO_SCROLL}
        accessibility={{ announcements: ANNOUNCEMENTS }}
        onDragStart={({ active, activatorEvent }) => {
          // A touch drag starts without a press activation, so an older press record is stale.
          const pressed =
            activatorEvent instanceof PointerEvent && activatorEvent.pointerType !== "touch";
          const noted = press.current === null ? null : viewKey(press.current.view);
          if (!pressed || noted !== active.id) press.current = null;
          followPointer(activatorEvent);
          setTabDrag({ title: titleOf(active.data.current), plan: null });
        }}
        onDragMove={({ active }) => {
          const plan = tabPlan(active.id);
          setTabDrag((current) =>
            current === null || samePlan(current.plan, plan) ? current : { ...current, plan },
          );
        }}
        onDragEnd={({ active }) => {
          const view = parseViewKey(String(active.id));
          const plan = tabPlan(active.id);
          const pressed = press.current;
          const restore =
            pressed && viewKey(pressed.view) === active.id ? pressed.restore : undefined;
          const copy = view !== null && copies(view);
          finishTabDrag();
          if (!plan || !view) return;
          update({
            type: "place",
            source: {
              view,
              ...(copy ? { copy } : {}),
              ...(restore === undefined ? {} : { restore }),
            },
            at: plan.at,
          });
        }}
        onDragCancel={finishTabDrag}
      >
        <div
          ref={(root) => {
            rootRef.current = root;
            return () => {
              rootRef.current = null;
              followingPointer.current?.abort();
            };
          }}
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
              chatControls={chatControls}
              update={update}
              notePress={notePress}
            />
          ))}
          {drawn.dividers.map((divider) => (
            <WorkAreaDivider
              key={divider.split.id}
              layout={layout}
              divider={divider}
              rootRef={rootRef}
              onPreview={previewRatio}
              onCommit={(ratio) => update({ type: "ratio", split: divider.split.id, ratio })}
              onSettle={() => previewRatio()}
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
    </PanelLinkOwnerContext>
  );
}

/**
 * What one `view` of a tab shows of `live`: a change lands in the view that leads the tab, and
 * another view keeps what it showed, then and once it leads. A view new to the pane, of another
 * tab or another thread's work area, shows `live`.
 */
function useViewShown<T>(view: string, live: T, leads: boolean): T {
  const [seen, setSeen] = useState({ view, live, shown: live });
  if (seen.view === view && seen.live === live) return seen.shown;
  const next = { view, live, shown: seen.view !== view || leads ? live : seen.shown };
  setSeen(next);
  return next.shown;
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
  readonly chatControls: ReactNode;
  readonly update: (change: WorkAreaChange) => void;
  readonly notePress: (view: ViewRef) => void;
}) {
  const { pane, layout, threadRef, tabs, update } = props;
  const { surfaces } = props.record;
  const entries = stripEntries(
    layout,
    props.record,
    pane.tabs,
    threadRef,
    WORK_AREA_COPY.chat,
    props.strip,
  );
  const tabOf = (entry: WorkAreaEntry) => surfaceTabId(entry.id);
  // This pane's view of a strip entry; the one strip's drawn pane is the focused one.
  const viewOf = (tab: TabId): ViewRef => ({
    pane: preferredView(layout, tab, pane.id, "user")?.id ?? pane.id,
    tab,
  });
  const gesture = (tab: TabId) => gestureViews(layout, viewOf(tab), props.strip);
  const closeEntry = (entry: WorkAreaEntry) =>
    closeTab(threadRef, gesture(tabOf(entry)), tabs.onCloseSurface);
  // Bulk closes never close a Chat; other tabs close once the surfaces' close path confirms.
  const closeEntries = (closing: readonly WorkAreaEntry[]) =>
    closeViews(
      threadRef,
      closing.flatMap((entry) => (entry.kind === "chat" ? [] : gesture(tabOf(entry)))),
      tabs.onCloseAllSurfaces,
    );
  // A browser or a side chat is created after an await, so its place travels with the request,
  // and its promise reaches a drop, which yields to what the user does before it settles. A drop
  // brings its own place, so it takes neither this pane's arm nor the launcher's.
  const armed =
    <T,>(kind: ArmKind, open: () => T) =>
    () =>
      openFromPaneMenu(threadRef, pane.id, kind, open);
  const openAfter = <T,>(tab: TabId, open: () => T) =>
    runOpen({ record: threadRef, tab, adjacent: true }, open);
  const fromLauncher =
    <T,>(open: () => T) =>
    () =>
      pane.active === LAUNCHER && currentDropAt(threadRef) === null
        ? openAfter(LAUNCHER, open)
        : open();
  const { onDuplicateBrowser: duplicate, ...stripProps } = tabs;
  // Split right or down copies a many-view tab into the new pane and moves a one-view tab there.
  const split = (entry: WorkAreaEntry, edge: Edge): WorkAreaChange => {
    const view = viewOf(tabOf(entry));
    const copy = viewsOf(layout, surfaces, view.tab) === "many";
    return {
      type: "place",
      source: { view, ...(copy ? { copy } : {}) },
      at: { kind: "edge", pane: view.pane, edge },
    };
  };
  const splitDisabled = (entry: WorkAreaEntry, edge: Edge) =>
    props.strip ||
    landingRect(layout, split(entry, edge), threadRef, surfaces, currentWorkAreaView()) === null;
  const moves = (entry: WorkAreaEntry) =>
    props.strip
      ? []
      : MOVE_ITEMS.flatMap(({ edge, label }) => {
          const move = moveToward(layout, viewOf(tabOf(entry)), edge);
          if (!move) return [];
          const fits =
            landingRect(layout, move, threadRef, surfaces, currentWorkAreaView()) !== null;
          return [{ id: `move-${edge}` as const, label, disabled: !fits, move }];
        });
  const tabMenu: RightPanelTabMenu = {
    items: (entry) => [
      {
        id: "split-right",
        label: WORK_AREA_COPY.splitRight,
        disabled: splitDisabled(entry, "right"),
      },
      {
        id: "split-down",
        label: WORK_AREA_COPY.splitDown,
        disabled: splitDisabled(entry, "bottom"),
      },
      ...moves(entry).map(({ move: _move, ...item }) => item),
    ],
    select: (action, entry) => {
      if (action !== "split-right" && action !== "split-down") {
        const move = moves(entry).find((item) => item.id === action);
        if (move && !move.disabled) update(move.move);
        return;
      }
      update(split(entry, action === "split-right" ? "right" : "bottom"));
    },
  };
  const modeSurfaceActions = [
    ...(tabs.modeSurfaceActions ?? []).map((action) => ({
      ...action,
      onClick: armed(action.id, action.onClick),
    })),
    ...(!isPlaced(layout.root, PRIMARY_CHAT)
      ? [
          chatSurfaceAction(
            armed("chat", () =>
              update({
                type: "place",
                source: { threads: [threadRef] },
                at: currentDropAt(threadRef) ?? { kind: "join", pane: pane.id },
              }),
            ),
          ),
        ]
      : []),
  ];
  const payload = layout.tabs[pane.active];
  const activeEntry = entries.find((entry) => entry.id === pane.active);
  // Of the views showing this tab, the focused one, else the first, takes its reveals.
  const leads =
    props.strip || preferredView(layout, pane.active, layout.focused, "reveal")?.id === pane.id;
  const viewId = viewScope(scopedThreadKey(threadRef), { pane: pane.id, tab: pane.active });
  // A line reveal shows in the view that leads its file; another view keeps the file as it was.
  const shown = useViewShown(
    viewId,
    payload?.kind === "linked-file"
      ? payload
      : activeEntry !== undefined && !isDisplayEntry(activeEntry) && activeEntry.kind === "file"
        ? activeEntry
        : null,
    leads,
  );
  const lone = !props.strip && layout.root.kind === "pane" && !pane.tabs.includes(LAUNCHER);
  const canSplit = useWorkAreaViewCheck(
    (view) =>
      lone &&
      landingRect(layout, { type: "split-launcher", pane: pane.id }, threadRef, surfaces, view) !==
        null,
  );
  const chatControls = pane.active === PRIMARY_CHAT ? props.chatControls : null;
  const layoutControls =
    chatControls || lone ? (
      <>
        {chatControls}
        {lone ? (
          <SplitLauncherButton
            disabled={!canSplit}
            onClick={() => update({ type: "split-launcher", pane: pane.id })}
          />
        ) : null}
      </>
    ) : undefined;
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
    ) : shown?.kind === "linked-file" ? (
      <LinkedFileBody
        owner={threadRef}
        tab={pane.active}
        entry={linkedFileEntry(pane.active, shown)}
        shown={shown.shown === true}
        keybindings={tabs.keybindings}
        availableEditors={props.availableEditors}
      />
    ) : activeEntry !== undefined && isReplyEntry(activeEntry) ? (
      <ReplyTabContext value={activeEntry}>
        {props.renderSurface(REPLIES_SURFACE, true)}
      </ReplyTabContext>
    ) : activeEntry !== undefined && !isDisplayEntry(activeEntry) ? (
      props.renderSurface(shown?.kind === "file" ? shown : activeEntry, true, closeEntry)
    ) : null;
  return (
    <div
      data-work-area-pane={pane.id}
      className={cn(
        // Its own layout root: the box comes from `pane.box`, not content. On a touch screen a pane
        // holding the Files tree stays as it was, since the tree's touch drag preview is fixed.
        "absolute flex min-h-0 min-w-0 flex-col contain-size contain-layout any-pointer-coarse:has-[[data-file-browser-panel]]:contain-none",
        !pane.focused && UNFOCUSED_PANE_CLASS,
      )}
      style={pane.box}
      onPointerDownCapture={(event) => {
        // A tab press activates its tab, which focuses the pane itself.
        if (pane.focused && pane.active !== layout.revealed) return;
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
          notePress: (surfaceId) => props.notePress(viewOf(surfaceTabId(surfaceId))),
          dragId: (surfaceId) => viewKey(viewOf(surfaceTabId(surfaceId))),
          leads,
          owner: threadRef,
          view: viewOf(pane.active),
        }}
      >
        <RightPanelTabs
          {...stripProps}
          mode="inline"
          surfaces={entries}
          activeSurfaceId={pane.active}
          layoutControls={layoutControls}
          {...(payload?.kind === "launcher" ? { launcher: { shortcuts: pane.focused } } : {})}
          onMoveSurface={ignoreMove}
          onActivate={(entry) => {
            // This view first: the surface path below names only the tab.
            update({ type: "activate", view: viewOf(tabOf(entry)) });
            if (!isDisplayEntry(entry)) {
              tabs.onActivate(entry);
              return;
            }
            focusChatComposer(layout.tabs[tabOf(entry)]);
          }}
          onCloseSurface={closeEntry}
          onCloseOtherSurfaces={(entry, strip) =>
            closeEntries(strip.filter((other) => other.id !== entry.id))
          }
          onCloseSurfacesToRight={(entry, strip) => {
            const index = strip.findIndex((other) => other.id === entry.id);
            if (index >= 0) closeEntries(strip.slice(index + 1));
          }}
          onCloseAllSurfaces={closeEntries}
          {...(duplicate
            ? {
                onDuplicateBrowser: (entry: WorkAreaEntry) => {
                  if (!isDisplayEntry(entry)) openAfter(tabOf(entry), () => duplicate(entry));
                },
              }
            : {})}
          onAddBrowser={armed("preview", fromLauncher(tabs.onAddBrowser))}
          onAddBrowserInProfile={(profileId) =>
            armed(
              "preview",
              fromLauncher(() => tabs.onAddBrowserInProfile(profileId)),
            )()
          }
          onAddTerminal={armed("terminal", tabs.onAddTerminal)}
          onAddDiff={armed("diff", tabs.onAddDiff)}
          onAddFiles={armed("files", tabs.onAddFiles)}
          onAddPullRequest={armed("pull-request", tabs.onAddPullRequest)}
          onAddPullRequests={armed("pull-requests", tabs.onAddPullRequests)}
          onAddDevice={armed("device", tabs.onAddDevice)}
          onAddSideChat={
            tabs.onAddSideChat ? armed("thread", fromLauncher(tabs.onAddSideChat)) : undefined
          }
          modeSurfaceActions={modeSurfaceActions}
        >
          <ChatOpenScope origin={null} opener={null}>
            {body}
          </ChatOpenScope>
        </RightPanelTabs>
      </RightPanelPaneContext>
    </div>
  );
}

function SplitLauncherButton(props: { readonly disabled: boolean; readonly onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0 [-webkit-app-region:no-drag]" />}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={WORK_AREA_COPY.splitRight}
          disabled={props.disabled}
          onClick={props.onClick}
        >
          <PanelRightIcon />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{WORK_AREA_COPY.splitRight}</TooltipPopup>
    </Tooltip>
  );
}

function WorkAreaDivider(props: {
  readonly layout: WorkAreaLayout;
  readonly divider: DrawnDivider;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly onPreview: (override: { readonly split: SplitId; readonly ratio: number }) => void;
  readonly onCommit: (ratio: number) => void;
  /** After a drag, whatever the store kept: commit, clamp or refusal. */
  readonly onSettle: () => void;
}) {
  const { divider, rootRef, onPreview, onCommit, onSettle } = props;
  const { split, parent } = divider;
  const row = split.axis === "row";
  const measure = () => {
    const root = rootRef.current;
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    const total = row ? parent.w * rect.width : parent.h * rect.height;
    const bounds = ratioBounds(props.layout, divider, { width: rect.width, height: rect.height });
    // A divider whose sides cannot both keep their minimum does not move.
    if (total <= 0 || bounds.min > bounds.max) return null;
    return {
      root,
      total,
      origin: row ? rect.left + parent.x * rect.width : rect.top + parent.y * rect.height,
      bounds,
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
    if (!measured) return;
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
      onSettle();
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
