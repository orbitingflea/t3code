import {
  PointerSensor,
  type PointerSensorOptions,
  TouchSensor,
  type TouchSensorOptions,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { ContextMenuItem } from "@t3tools/contracts";
import {
  type ComponentProps,
  createContext,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  useContext,
  useRef,
} from "react";

import type { PreviewPanelShell } from "~/components/preview/PreviewPanelShell";
import { workspaceAreaProps } from "~/lib/workspaceFocus";

import { modeSurfaceLabel } from "../dashboard/dashboardSurface";
import type { DisplayEntry, Edge, PaneId, ReplyEntry, WorkAreaEntry } from "./workArea.logic";
import type { PaneEdges } from "./workAreaGeometry.logic";

export { isDisplayEntry, type WorkAreaEntry } from "./workArea.logic";

export type PaneMenuAction = "split-right" | "split-down" | `move-${Edge}`;

/** Split entries for a tab's context menu. */
export interface RightPanelTabMenu {
  readonly items: (surface: WorkAreaEntry) => ContextMenuItem<PaneMenuAction>[];
  readonly select: (action: PaneMenuAction, surface: WorkAreaEntry) => void;
}

interface TabDragData {
  readonly kind: "tab";
  readonly title: string;
}

/**
 * What a `RightPanelTabs` inside the work area knows about its pane. Absent on the Pull requests
 * page. Inside it, one drag context spans every strip, so a tab can leave its strip.
 */
interface RightPanelPane {
  readonly id: PaneId;
  /** Which window edges the pane touches: title-bar ownership and corner insets follow them. */
  readonly edges: PaneEdges;
  readonly focused: boolean;
  readonly tabMenu: RightPanelTabMenu;
  /** Runs before a press activates its tab, so a drop can give the pane back what it showed. */
  readonly notePress: (surfaceId: string) => void;
  /** Per-view drag id for `surfaceId` in this pane, unique across panes in the shared drag context. */
  readonly dragId: (surfaceId: string) => string;
  /** Whether this pane leads reveals for its active tab; other views of the tab keep their scroll. */
  readonly leads: boolean;
  /** View reading-place scope; undefined in the narrow strip, which uses the file's place. */
  readonly readingScope: string | undefined;
}

export const RightPanelPaneContext = createContext<RightPanelPane | null>(null);

export const ReplyTabContext = createContext<ReplyEntry | null>(null);

export function useRightPanelPane(): RightPanelPane | null {
  return useContext(RightPanelPaneContext);
}

export function displayTitle(entry: DisplayEntry): string {
  switch (entry.kind) {
    case "chat":
    case "launcher":
      return entry.title;
    case "replies":
      return modeSurfaceLabel("replies");
    case "file":
      return entry.relativePath.slice(entry.relativePath.lastIndexOf("/") + 1);
  }
}

export function tabDragData(title: string): TabDragData {
  return { kind: "tab", title };
}

/**
 * A strip's close entries for the work area's Chat tabs: the last Chat never closes, and bulk closes
 * skip Chats, so an entry that would close only Chats is off. Without Chats the entries are as given.
 */
export function withChatClosing<T extends string>(
  items: readonly ContextMenuItem<T>[],
  surface: WorkAreaEntry,
  strip: readonly WorkAreaEntry[],
): ContextMenuItem<T>[] {
  const index = strip.findIndex((entry) => entry.id === surface.id);
  const bulk = new Map<string, readonly WorkAreaEntry[]>([
    ["close-others", strip.filter((entry) => entry.id !== surface.id)],
    ["close-to-right", strip.slice(index + 1)],
    ["close-all", strip],
  ]);
  return items.map((item) => {
    if (item.id === "close") {
      return surface.kind === "chat" && !surface.closable ? { ...item, disabled: true } : item;
    }
    const closing = bulk.get(item.id);
    return closing === undefined
      ? item
      : { ...item, disabled: !closing.some((entry) => entry.kind !== "chat") };
  });
}

/** Close, mute and the rename input: a press on them neither activates nor drags. */
function isTabControl(target: EventTarget | null, tab: EventTarget | null): boolean {
  if (!(target instanceof Element) || !(tab instanceof Element)) return false;
  const control = target.closest("button:not([data-tab-title]), input");
  return control !== null && control !== tab && tab.contains(control);
}

/**
 * Activation for a whole tab. A primary mouse or pen press activates at once, before any drag
 * threshold can swallow it, and keeps focus where activation put it (a terminal). Touch and
 * keyboard activate on click; the click that ends a press activation does nothing.
 */
export function useTabPress<Entry extends WorkAreaEntry>(
  surface: Entry,
  onActivate: (surface: Entry) => void,
) {
  const pane = useRightPanelPane();
  const pressActivated = useRef(false);
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      pressActivated.current = false;
      if (event.button !== 0 || (event.pointerType !== "mouse" && event.pointerType !== "pen")) {
        return;
      }
      if (isTabControl(event.target, event.currentTarget)) return;
      pressActivated.current = true;
      pane?.notePress(surface.id);
      onActivate(surface);
    },
    onMouseDown: (event: ReactMouseEvent<HTMLElement>) => {
      // An open rename input still ends on a press elsewhere on its tab.
      if (event.currentTarget.querySelector("input")) return;
      if (event.button === 0 && !isTabControl(event.target, event.currentTarget)) {
        event.preventDefault();
      }
    },
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (isTabControl(event.target, event.currentTarget)) return;
      const endsPress = pressActivated.current && event.detail !== 0;
      pressActivated.current = false;
      if (!endsPress) onActivate(surface);
    },
  };
}

class TabPointerSensor extends PointerSensor {
  static override activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (event: ReactPointerEvent, { onActivation }: PointerSensorOptions) => {
        const { nativeEvent } = event;
        if (!nativeEvent.isPrimary || nativeEvent.button !== 0) return false;
        if (nativeEvent.pointerType === "touch") return false;
        if (isTabControl(event.target, event.currentTarget)) return false;
        onActivation?.({ event: nativeEvent });
        return true;
      },
    },
  ];
}

class TabTouchSensor extends TouchSensor {
  static override activators = [
    {
      eventName: "onTouchStart" as const,
      handler: (event: ReactTouchEvent, { onActivation }: TouchSensorOptions) => {
        if (event.nativeEvent.touches.length > 1) return false;
        if (isTabControl(event.target, event.currentTarget)) return false;
        onActivation?.({ event: event.nativeEvent });
        return true;
      },
    },
  ];
}

/** A touch drag needs a hold, so a swipe scrolls the strip and a tap activates. */
export function useTabDragSensors() {
  return useSensors(
    useSensor(TabPointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TabTouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
}

/**
 * What a work-area pane's `RightPanelTabs` renders instead of its own `PreviewPanelShell`. Only the
 * focused pane is the "panel" area, so programmatic focus lands there; F6 visits the others too.
 */
export function SplitPaneFrame(props: ComponentProps<typeof PreviewPanelShell>) {
  const pane = useRightPanelPane();
  const label = props.workspaceLabel ?? "Workspace panel";
  const area = props.workspaceArea
    ? {
        ...workspaceAreaProps(pane?.focused === false ? "pane" : "panel", 4, label),
        "data-workspace-focus-key": props.workspaceFocusKey,
      }
    : { role: "region", "aria-label": label };
  return (
    <div
      {...area}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      onMouseDown={props.onMouseDown}
      onMouseUp={props.onMouseUp}
    >
      {props.children}
    </div>
  );
}

/** The icon slot of a tab that cannot close: `PanelTabCloseButton`'s place, without its button. */
export function UnclosableTabIcon(props: {
  readonly children: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      {props.children}
    </span>
  );
}
