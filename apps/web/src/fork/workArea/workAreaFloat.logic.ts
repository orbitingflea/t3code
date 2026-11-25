import type { ThreadRightPanelState } from "~/rightPanelStore";

import {
  findPane,
  insertTabs,
  isPlaced,
  leaves,
  preferredView,
  PRIMARY_CHAT,
  PRIMARY_PAYLOAD,
  removeTabs,
  resolveLayout,
  setPane,
  type TabId,
  withPayload,
  type WorkAreaLayout,
} from "./workArea.logic";
import { primaryChatRect, type WorkAreaView } from "./workAreaGeometry.logic";
import type { LayoutWriteKind } from "./workAreaPlacement.logic";

// The mini player mounts inside the primary Chat column, so a float must make it visible.
function showingPrimaryChat(layout: WorkAreaLayout, view: WorkAreaView): WorkAreaLayout {
  if (primaryChatRect(layout, view) !== null) return layout;
  const pane = preferredView(layout, PRIMARY_CHAT, undefined, "automatic");
  if (pane) return { ...setPane(layout, { ...pane, active: PRIMARY_CHAT }), focused: pane.id };
  const focused = findPane(layout.root, layout.focused) ?? leaves(layout.root)[0]!;
  return setPane(
    withPayload(layout, PRIMARY_CHAT, PRIMARY_PAYLOAD),
    insertTabs(focused, [PRIMARY_CHAT], null, true),
  );
}

export function floatTab(layout: WorkAreaLayout, tab: TabId, view: WorkAreaView): WorkAreaLayout {
  if (!isPlaced(layout.root, tab)) return layout;
  const docked = layout.floating ? unfloatTab(layout, layout.floating.tab) : layout;
  // Only one-view tabs float, so the tab has this one pane.
  const pane = preferredView(docked, tab, undefined, "automatic")!;
  const before = pane.tabs[pane.tabs.indexOf(tab) + 1] ?? null;
  const floating = { tab, pane: pane.id, before };
  return showingPrimaryChat({ ...removeTabs(docked, new Set([tab])), floating }, view);
}

export const withoutFloating = (layout: WorkAreaLayout): WorkAreaLayout => {
  const { floating: _floating, ...rest } = layout;
  return rest;
};

/** Back into the pane it floated from, in the background; with that pane gone, in no pane. */
export function unfloatTab(layout: WorkAreaLayout, tab: TabId): WorkAreaLayout {
  if (layout.floating?.tab !== tab) return layout;
  const rest = withoutFloating(layout);
  const home = findPane(rest.root, layout.floating.pane);
  if (!home) return rest;
  return setPane(rest, insertTabs(home, [tab], layout.floating.before, false));
}

// The one way into `floating`: upstream's close (PiP, device Float, Preview toggle) while the
// mini player plays a tab a pane holds. Any other close changes nothing, so no tab goes unseen.
export function floatedByClose(
  prev: ThreadRightPanelState,
  next: ThreadRightPanelState,
  write: LayoutWriteKind,
  playing: TabId | null,
): TabId | null {
  if (playing === null || write !== "user" || !prev.isOpen || next.isOpen) return null;
  if (next.surfaces !== prev.surfaces) return null;
  return isPlaced(resolveLayout(prev).root, playing) ? playing : null;
}

// A floating tab needs the drawn primary Chat that holds the mini player; else it goes back.
export const keptFloat = (layout: WorkAreaLayout, view: WorkAreaView): WorkAreaLayout =>
  layout.floating === undefined || primaryChatRect(layout, view) !== null
    ? layout
    : unfloatTab(layout, layout.floating.tab);
