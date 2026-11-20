import type { ThreadRightPanelState } from "~/rightPanelStore";

import {
  findPane,
  insertTabs,
  leaves,
  paneHolding,
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
  const pane = paneHolding(layout.root, PRIMARY_CHAT);
  if (pane) return { ...setPane(layout, { ...pane, active: PRIMARY_CHAT }), focused: pane.id };
  const focused = findPane(layout.root, layout.focused) ?? leaves(layout.root)[0]!;
  return setPane(
    withPayload(layout, PRIMARY_CHAT, PRIMARY_PAYLOAD),
    insertTabs(focused, [PRIMARY_CHAT], null, true),
  );
}

// Repair returns an earlier floating tab, now in no pane, to the background.
export function floatTab(layout: WorkAreaLayout, tab: TabId, view: WorkAreaView): WorkAreaLayout {
  if (!paneHolding(layout.root, tab)) return layout;
  return showingPrimaryChat({ ...removeTabs(layout, new Set([tab])), floating: tab }, view);
}

export function unfloatTab(layout: WorkAreaLayout, tab: TabId): WorkAreaLayout {
  if (layout.floating !== tab) return layout;
  const { floating: _floating, ...rest } = layout;
  return rest;
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
  return paneHolding(resolveLayout(prev).root, playing) ? playing : null;
}

// A floating tab needs the drawn primary Chat that holds the mini player; else it goes back.
export const keptFloat = (layout: WorkAreaLayout, view: WorkAreaView): WorkAreaLayout =>
  layout.floating === undefined || primaryChatRect(layout, view) !== null
    ? layout
    : unfloatTab(layout, layout.floating);
