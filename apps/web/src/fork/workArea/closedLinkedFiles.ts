import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ChatFileAttachment, ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ClosedView, ClosedViewEntry } from "~/closedViewStore";
import type { ThreadRightPanelState } from "~/rightPanelStore";

import { asTabId, linkedFileTabId, resolveLayout } from "./workArea.logic";
import type { WorkAreaChange } from "./workAreaPlacement.logic";

// Closed-tab history keeps file surfaces, and Reopen Closed Tab passes `openFile` only the path
// and line. A linked file's path holds its source thread after a NUL, which no real path has.
const LINKED_PATH = "\u0000linked:";

const isLinkedPath = Schema.is(
  Schema.Struct({
    source: ScopedThreadRef,
    path: Schema.String,
    attachment: Schema.optional(ChatFileAttachment),
  }),
);

// The linked files a close removed from `after`'s layout, as closed file tabs of `threadRef`.
export function closedLinkedFiles(
  threadRef: ScopedThreadRef,
  before: ThreadRightPanelState,
  after: ThreadRightPanelState,
): ClosedView[] {
  if (before.workArea === after.workArea) return [];
  const kept = resolveLayout(after).tabs;
  return Object.entries(resolveLayout(before).tabs).flatMap(([tab, payload]) => {
    if (payload?.kind !== "linked-file" || kept[asTabId(tab)] !== undefined) return [];
    const { source, path, attachment } = payload;
    const relativePath = `${LINKED_PATH}${JSON.stringify({
      source: { environmentId: source.environmentId, threadId: source.threadId },
      path,
      ...(attachment === undefined ? {} : { attachment }),
    })}`;
    return [
      {
        kind: "panel-tab",
        threadRef,
        surface: {
          id: `file:${relativePath}`,
          kind: "file",
          relativePath,
          revealLine: payload.line,
          revealRequestId: payload.reveal,
        },
      },
    ];
  });
}

// The link a reopened `closedLinkedFiles` path opens in place of a file tab.
export function reopenedLinkedFile(
  relativePath: string,
  line: number | undefined,
): WorkAreaChange | null {
  if (!relativePath.startsWith(LINKED_PATH)) return null;
  let linked: unknown;
  try {
    linked = JSON.parse(relativePath.slice(LINKED_PATH.length));
  } catch {
    return null;
  }
  if (!isLinkedPath(linked)) return null;
  return {
    type: "link-file",
    source: linked.source,
    path: linked.path,
    line: line ?? null,
    ...(linked.attachment === undefined ? {} : { attachment: linked.attachment }),
  };
}

// `planNextReopen` skips an entry whose surface is open again, which a linked file never has, so
// its entries are matched here against the linked tabs open in their owner's layout.
export function partitionOpenLinkedFiles(
  entries: readonly ClosedViewEntry[],
  byThreadKey: Record<string, ThreadRightPanelState>,
): { readonly closed: ClosedViewEntry[]; readonly open: ClosedViewEntry[] } {
  const closed: ClosedViewEntry[] = [];
  const open: ClosedViewEntry[] = [];
  for (const entry of entries) {
    const linked =
      entry.kind === "panel-tab" && entry.surface.kind === "file"
        ? reopenedLinkedFile(entry.surface.relativePath, undefined)
        : null;
    const record = byThreadKey[scopedThreadKey(entry.threadRef)];
    const isOpen =
      linked?.type === "link-file" &&
      record !== undefined &&
      resolveLayout(record).tabs[
        linkedFileTabId(linked.source, linked.path, linked.attachment?.id)
      ] !== undefined;
    (isOpen ? open : closed).push(entry);
  }
  return { closed, open };
}
