import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { MessageSquare, Plus } from "lucide-react";
import { createElement, type ReactNode, useState } from "react";

import { useQuietThreadShell } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";

import {
  firstLine,
  useSubThreadStates,
  useSubThreadSummaries,
} from "../subThreads/subThreadsState";
import { isReplyEntry, type WorkAreaEntry } from "./workArea.logic";

/** How a work-area tab draws in place of the strip's default. */
export interface TabPresentation {
  /** Null keeps the strip's title. */
  readonly title: string | null;
  /** The thread whose run state the tab shows. */
  readonly shell: EnvironmentThreadShell | null;
  readonly closable: boolean;
  readonly icon: ReactNode;
}

const CHAT_ICON = createElement(MessageSquare, { className: "size-3 shrink-0" });
const LAUNCHER_ICON = createElement(Plus, { className: "size-3 shrink-0" });

/**
 * Presentation for a Chat, launcher (New tab), or reply tab, or null for any other tab. Chat and
 * launcher tabs get their icon here, and the launcher gets only an icon. A Chat uses its thread
 * title or omitted-thread link title, and the last Chat has no close button. A reply tab uses its
 * server summary or first line, read from thread history only while shown and kept after.
 */
export function useTabPresentation(surface: WorkAreaEntry, shown: boolean): TabPresentation | null {
  const chat = surface.kind === "chat" ? (surface.thread ?? null) : null;
  const shell = useQuietThreadShell(chat);
  const omitted = chat !== null && shell === null ? chat : null;
  const links = useEnvironmentQuery(
    omitted
      ? orchestrationEnvironment.threadLinkMetadata({
          environmentId: omitted.environmentId,
          input: { threadIds: [omitted.threadId] },
        })
      : null,
  ).data;
  const reply = isReplyEntry(surface) ? surface.reply : null;
  const states = useSubThreadStates(reply?.thread ?? null);
  const summaries = useSubThreadSummaries(shown ? (reply?.thread ?? null) : null);
  const summary = reply ? summaries.get(reply.first) : undefined;
  const loaded = summary ? firstLine(summary.firstText) : null;
  const [kept, setKept] = useState<string | null>(null);
  if (loaded !== null && loaded !== kept) setKept(loaded);
  if (surface.kind === "chat") {
    const link = omitted ? links?.[omitted.threadId]?.title.trim() : undefined;
    return {
      title: shell?.title ?? (link || null),
      shell,
      closable: surface.closable,
      icon: CHAT_ICON,
    };
  }
  if (surface.kind === "launcher") {
    return { title: null, shell: null, closable: true, icon: LAUNCHER_ICON };
  }
  if (reply === null) return null;
  return {
    title: states.get(reply.first)?.summary || (loaded ?? kept),
    shell: null,
    closable: true,
    icon: null,
  };
}
