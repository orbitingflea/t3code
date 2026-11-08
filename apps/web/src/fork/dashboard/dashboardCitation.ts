import type { AssistantCitation, DashboardSlotId, ScopedThreadRef } from "@t3tools/contracts";
import type { ComponentProps } from "react";

import type { AssistantSelectionToolbar } from "../../components/chat/AssistantSelectionToolbar";
import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";
import { isWorkspaceElementVisible } from "../../lib/workspaceFocus";

// A Dashboard quote is an ordinary citation whose message id names a slot. Any id with this
// prefix belongs to the Dashboard, so even a slot this client does not know never reaches the
// timeline's history search.
const SLOT_ID_PREFIX = "dashboard-slot-";

export type CiteAssistantText = ComponentProps<typeof AssistantSelectionToolbar>["onCite"];

/** The attributes that make an element a citation source, as `AssistantCitationSource` sets them. */
export function dashboardCitationSourceProps(threadRef: ScopedThreadRef, slot: DashboardSlotId) {
  return {
    "data-assistant-citation-source": `${SLOT_ID_PREFIX}${slot}`,
    "data-assistant-citation-environment": threadRef.environmentId,
    "data-assistant-citation-thread": threadRef.threadId,
  };
}

export function isDashboardCitation(citation: AssistantCitation): boolean {
  return citation.messageId.startsWith(SLOT_ID_PREFIX);
}

/** The citation the timeline can jump to, or null for a Dashboard quote. */
export function timelineCitation(citation: AssistantCitation | null): AssistantCitation | null {
  return citation !== null && isDashboardCitation(citation) ? null : citation;
}

/**
 * Moves focus as a Dashboard quote's comment box closes. `savedFrom` is an element in the composer
 * the comment was saved from, null or omitted when the box closed without Save. After Save into a
 * reachable composer, for a message quote, or with no source, returns false so the caller
 * restores composer focus. Otherwise focuses the slot's card; returns whether it took focus.
 */
export function focusDashboardCitationSource(
  citation: AssistantCitation,
  anchor: AssistantCitationSourceAnchor | undefined,
  savedFrom?: HTMLElement | null,
): boolean {
  if (!isDashboardCitation(citation) || anchor === undefined) return false;
  if (savedFrom != null && isWorkspaceElementVisible(savedFrom)) return false;
  const card = anchor.source.closest<HTMLElement>("[data-slot]");
  card?.focus({ preventScroll: true });
  return card != null && card.ownerDocument.activeElement === card;
}

/**
 * An open comment box re-checks its quoted slot only on a DOM change inside the viewport, and
 * removing the whole viewport is not one. Making one lets the box see that its source is gone.
 */
export function releaseDashboardCitationViewport(viewport: HTMLElement): void {
  viewport.appendChild(viewport.ownerDocument.createTextNode("")).remove();
}
