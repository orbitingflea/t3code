import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { DASHBOARD_LINK_HREF } from "@t3tools/shared/displayModes";
import { use } from "react";

import { ContextChip, ContextChipLabel } from "../../components/ContextChip";
import { hastPlainTextDeep } from "../../components/chat/markdownHast.logic";
import { toastManager } from "../../components/ui/toast";
import { requestWorkspaceFocus } from "../../lib/workspaceFocus";
import {
  rightPanelHostRef,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { type ChatFileOpener, fromChatOrigin } from "../workArea/chatFileOpener";
import { ChatOpenerContext } from "../workArea/chatOpenerContext";
import { type PanelLink, startPanelOnlyDrag } from "../workArea/panelLinkDrag";
import { shownSurfaceOf } from "../workArea/workAreaView";
import { FORK_SURFACES, threadHasModeSurface } from "./dashboardSurface";

/** "open" for the Dashboard link, "inert" for any other `t3-dashboard:` link, null otherwise. */
export function parseDashboardHref(href: string | undefined): "open" | "inert" | null {
  if (href === DASHBOARD_LINK_HREF) return "open";
  return href?.startsWith(DASHBOARD_LINK_HREF) ? "inert" : null;
}

/** A Dashboard link's written text, or "Dashboard" when it has none of its own. */
export function dashboardLinkLabel(node: unknown, href: string): string {
  const written = hastPlainTextDeep(node).trim();
  return written === "" || written === href ? "Dashboard" : written;
}

function isHostedThread(threadRef: ScopedThreadRef): boolean {
  return scopedThreadKey(rightPanelHostRef(threadRef)) !== scopedThreadKey(threadRef);
}

/** Opens `threadRef`'s Dashboard beside the link's chat, or focuses it if already shown. */
export function openThreadDashboard(threadRef: ScopedThreadRef, opener: ChatFileOpener | null) {
  // A hosted thread's actions open in its host's panel, which shows the host's Dashboard.
  if (isHostedThread(threadRef)) {
    toastManager.add({ type: "info", title: "Open this thread on its own to see its Dashboard" });
    return;
  }
  if (!threadHasModeSurface(threadRef, "dashboard")) {
    toastManager.add({ type: "info", title: "This thread's Dashboard is off" });
    return;
  }
  const store = useRightPanelStore.getState();
  const alreadyShown =
    shownSurfaceOf(selectThreadRightPanelState(store.byThreadKey, threadRef), "dashboard") !==
    undefined;
  fromChatOrigin(opener, () => store.open(threadRef, "dashboard"));
  // Opening an already active tab changes no panel state, so nothing else moves focus there.
  if (alreadyShown) requestWorkspaceFocus({ area: "panel" });
}

/** What a drop of the chip on a right-panel pane opens, when the click would open the Dashboard. */
function dashboardPanelLink(
  threadRef: ScopedThreadRef,
  opener: ChatFileOpener | null,
): PanelLink | null {
  if (isHostedThread(threadRef) || !threadHasModeSurface(threadRef, "dashboard")) return null;
  return { panelRef: threadRef, open: () => openThreadDashboard(threadRef, opener) };
}

/** A chat link to the thread's Dashboard: a chip that opens it, or plain text when it cannot. */
export function DashboardLinkChip(props: {
  readonly threadRef: ScopedThreadRef | undefined;
  readonly node: unknown;
  readonly href: string;
}) {
  const label = dashboardLinkLabel(props.node, props.href);
  const { threadRef } = props;
  const opener = use(ChatOpenerContext);
  if (parseDashboardHref(props.href) !== "open" || threadRef === undefined) return label;
  const Icon = FORK_SURFACES.dashboard.icon;
  return (
    <ContextChip
      render={<button type="button" />}
      aria-label={label === "Dashboard" ? "Open the Dashboard" : `${label}. Open the Dashboard`}
      data-markdown-copy={`[${label.replace(/[\\[\]*_`<>&]/g, "\\$&")}](${DASHBOARD_LINK_HREF})`}
      onClick={() => openThreadDashboard(threadRef, opener)}
      draggable
      onDragStart={(event) => startPanelOnlyDrag(event, dashboardPanelLink(threadRef, opener))}
    >
      <Icon aria-hidden />
      <ContextChipLabel>{label}</ContextChipLabel>
    </ContextChip>
  );
}
