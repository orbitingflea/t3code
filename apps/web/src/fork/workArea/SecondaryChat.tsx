import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { BackgroundThreadContext } from "~/components/chat/backgroundThread";
import ChatView from "~/components/ChatView";
import { Button } from "~/components/ui/button";
import { ComposerHandleContext } from "~/composerHandleContext";
import { WORK_AREA_COPY } from "~/fork/forkCopy";
import type { SideChatParentPanel } from "~/lib/sideChatPane";
import { buildThreadRouteParams } from "~/threadRoutes";

import { hostShownChat, type OpenOrigin, OpenOriginContext } from "./chatFileOpener";
import { useThreadPlace } from "./chatOpenerContext";
import { projectRelation } from "./threadLink.logic";
import { useThreadGone } from "./useThreadGone";
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
  // Persisted layouts can still hold another project's Chat tab; show a link instead of mounting.
  const relation = projectRelation(owner, useThreadPlace(owner), thread, useThreadPlace(thread));
  const navigate = useNavigate();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- routes the shown thread's panel actions to the owner's layout while mounted, as a side chat does
  useEffect(
    () => (relation === "same" ? hostShownChat(thread, owner) : undefined),
    [thread, owner, relation],
  );
  const gone = useThreadGone(thread);
  if (relation === "other") {
    return (
      <div className="flex flex-col items-start gap-2 p-3 text-muted-foreground text-xs">
        <p>{WORK_AREA_COPY.otherProjectChat}</p>
        <Button
          variant="outline"
          size="xs"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(thread),
            })
          }
        >
          {WORK_AREA_COPY.openThread}
        </Button>
      </div>
    );
  }
  const { environmentId: ownerEnvironmentId, threadId: ownerThreadId } = owner;
  const origin: OpenOrigin = {
    kind: "shown",
    owner: scopeThreadRef(ownerEnvironmentId, ownerThreadId),
    tab,
    placement,
  };
  if (gone !== false || relation === null) {
    return gone ? (
      <p className="p-3 text-xs text-muted-foreground">{WORK_AREA_COPY.missingThread}</p>
    ) : null;
  }
  return (
    <div
      data-side-chat-pane={thread.threadId}
      className="@container/chat flex h-full min-h-0 flex-col"
    >
      <OpenOriginContext value={origin}>
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
