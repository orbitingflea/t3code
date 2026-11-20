import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { BackgroundThreadContext } from "~/components/chat/backgroundThread";
import ChatView from "~/components/ChatView";
import { ComposerHandleContext } from "~/composerHandleContext";
import { WORK_AREA_COPY } from "~/fork/forkCopy";
import type { SideChatParentPanel } from "~/lib/sideChatPane";
import { useQuietThreadShell } from "~/state/entities";
import { useEnvironmentShellHasSnapshot } from "~/state/shell";

import { hostShownChat, OpenOriginContext } from "./chatFileOpener";
import type { TabId } from "./workArea.logic";

// Another thread's code never runs in the primary's terminal, and its tool diffs have no panel here.
const NO_PARENT_PANEL: SideChatParentPanel = {};

/** Another thread's chat as a work-area tab: the side-chat embedding, mounted while shown. */
export function SecondaryChat(props: {
  readonly thread: ScopedThreadRef;
  readonly owner: ScopedThreadRef;
  readonly tab: TabId;
  readonly placement: number;
}) {
  const { thread, owner, tab, placement } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- routes the shown thread's panel actions to the owner's layout while mounted, as a side chat does
  useEffect(() => hostShownChat(thread, owner), [thread, owner]);
  const shell = useQuietThreadShell(thread);
  const loaded = useEnvironmentShellHasSnapshot(thread.environmentId);
  if (shell === null) {
    return loaded ? (
      <p className="p-3 text-xs text-muted-foreground">{WORK_AREA_COPY.missingThread}</p>
    ) : null;
  }
  return (
    <div data-side-chat-pane={thread.threadId} className="flex h-full min-h-0 flex-col">
      <OpenOriginContext value={{ kind: "shown", owner, tab, placement }}>
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              environmentId={thread.environmentId}
              threadId={thread.threadId}
              routeKind="server"
              embedded={NO_PARENT_PANEL}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      </OpenOriginContext>
    </div>
  );
}
