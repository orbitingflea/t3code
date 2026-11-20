import { findReusableProjectScriptTerminal } from "~/lib/projectScriptTerminal";
import type { RightPanelSurface } from "~/rightPanelStore";

export const tabTerminalIds = (surfaces: ReadonlyArray<RightPanelSurface>): string[] =>
  surfaces.flatMap((surface) => (surface.kind === "terminal" ? surface.terminalIds : []));

// Every terminal is a tab terminal here, so none is "panel-owned" in upstream's sense.
export function reusableTabTerminal(
  surfaces: ReadonlyArray<RightPanelSurface>,
  shownTerminal: string | null,
  running: ReadonlyArray<string>,
  closing: ReadonlyArray<string>,
): string | null {
  return findReusableProjectScriptTerminal({
    drawerTerminalIds: tabTerminalIds(surfaces),
    activeTerminalId: shownTerminal ?? "",
    panelTerminalIds: new Set(),
    runningTerminalIds: running,
    closingTerminalIds: closing,
  });
}

// `seen` holds the listed ids that had a tab or were adopted, so a tab the user closed stays
// closed while its session is listed (a failed or read-only close) and comes back once relisted.
export function adoptedTerminals(input: {
  readonly sessionIds: ReadonlyArray<string>;
  readonly tabIds: ReadonlyArray<string>;
  readonly seen: ReadonlySet<string>;
  readonly skipped: ReadonlyArray<string>;
}): { readonly adopt: string[]; readonly seen: Set<string> } {
  const tabs = new Set(input.tabIds);
  const adopt = input.sessionIds.filter(
    (id) => !tabs.has(id) && !input.seen.has(id) && !input.skipped.includes(id),
  );
  const listed = new Set(input.sessionIds);
  const seen = new Set([...input.seen, ...tabs, ...adopt].filter((id) => listed.has(id)));
  return { adopt, seen };
}
