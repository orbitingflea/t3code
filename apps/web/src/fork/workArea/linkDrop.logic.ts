import type { ScopedThreadRef } from "@t3tools/contracts";

import type { PanelLink } from "./panelLinkDrag";
import { asTabId, type WorkAreaLayout, withPayload } from "./workArea.logic";

// A dragged link's tab id is unknown before its open; fits are planned for this stand-in, as wide
// as the tab the link opens needs.
export const LINK_PROBE = asTabId("link-drop-probe");

export const probeLayout = (
  layout: WorkAreaLayout,
  owner: ScopedThreadRef,
  link: Pick<PanelLink, "composer">,
): WorkAreaLayout =>
  withPayload(
    layout,
    LINK_PROBE,
    link.composer ? { kind: "secondary-chat", thread: owner, placement: 0 } : { kind: "surface" },
  );

/**
 * The first of copy, link and move that the source's `effectAllowed` permits; a `dropEffect`
 * outside it makes the browser refuse the drop.
 */
export function dropEffectFor(effectAllowed: string): "copy" | "link" | "move" | null {
  if (effectAllowed === "none") return null;
  if (effectAllowed === "all" || effectAllowed === "uninitialized") return "copy";
  const allowed = effectAllowed.toLowerCase();
  return (["copy", "link", "move"] as const).find((effect) => allowed.includes(effect)) ?? null;
}
