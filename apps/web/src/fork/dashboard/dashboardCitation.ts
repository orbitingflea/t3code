import type { AssistantCitation, DashboardSlotId, ScopedThreadRef } from "@t3tools/contracts";
import type { ComponentProps } from "react";

import type { AssistantSelectionToolbar } from "../../components/chat/AssistantSelectionToolbar";
import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";

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
 * Gives keyboard focus back to the quoted slot's card when its comment box closes. The composer
 * can sit behind the modal Dashboard sheet, so it is the wrong place for focus. Returns false,
 * and leaves focus alone, for a message quote or a card that cannot take focus now.
 */
export function focusDashboardCitationSource(
  citation: AssistantCitation,
  anchor: AssistantCitationSourceAnchor | undefined,
): boolean {
  if (!isDashboardCitation(citation) || anchor === undefined) return false;
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
