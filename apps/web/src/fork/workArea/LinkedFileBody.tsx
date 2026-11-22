import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EditorId, ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense } from "react";

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { WORK_AREA_COPY } from "~/fork/forkCopy";
import { useProject, useQuietThreadProjection, useQuietThreadShell } from "~/state/entities";
import { environmentThreadDetails } from "~/state/threads";

import { OpenOriginContext, openLinkedFolder } from "./chatFileOpener";
import { linkedTreeOwner } from "./linkSources";
import { PanelLinkOwnerContext } from "./panelLinkDrag";
import { threadWorkspace } from "./threadWorkspace.logic";
import { type LinkedFileEntry, openInFileTab, type TabId } from "./workArea.logic";

const FilePreviewPanel = lazy(() => import("~/components/files/FilePreviewPanel"));

const ignore = () => {};

/** Where `thread` works: its shell's place, else its detail's, which a families server's shell lacks. */
function useThreadWorkspace(thread: ScopedThreadRef) {
  const shell = useQuietThreadShell(thread);
  const detail = useQuietThreadProjection(shell === null ? thread : null);
  const error = useAtomValue(environmentThreadDetails.errorAtom(thread));
  const place = shell ?? detail?.projection.thread ?? null;
  const project = useProject(place ? scopeProjectRef(thread.environmentId, place.projectId) : null);
  return threadWorkspace(place, project, error);
}

const note = (text: string) => <p className="p-3 text-muted-foreground text-xs">{text}</p>;

/**
 * A file or attachment another thread's Chat opened here, read in that thread's project. A link in
 * its rendered text opens in this layout beside it; its Files tree opens as from no pane. Its folder
 * breadcrumbs move the owner's explorer only when both threads work in one workspace.
 */
export function LinkedFileBody(props: {
  readonly owner: ScopedThreadRef;
  readonly tab: TabId;
  readonly entry: LinkedFileEntry;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly availableEditors: ReadonlyArray<EditorId>;
}) {
  const { entry, owner, tab } = props;
  const { source, attachment } = entry;
  const workspace = useThreadWorkspace(source);
  const ownerWorkspace = useThreadWorkspace(owner);
  const workspaceMutationId = useAtomValue(
    environmentThreadDetails.workspaceMutationIdAtom(source),
  );
  const ownsOpenIn = useRightPanelStore(
    (state) => openInFileTab(selectThreadRightPanelState(state.byThreadKey, owner)) === tab,
  );
  if (workspace.kind === "loading") return note(WORK_AREA_COPY.loadingLinkedFile);
  if (workspace.kind === "error") return note(WORK_AREA_COPY.linkedFileFailed(workspace.message));
  const { project, cwd } = workspace;
  const sharesWorkspace =
    source.environmentId === owner.environmentId &&
    ownerWorkspace.kind === "ready" &&
    ownerWorkspace.cwd === cwd;
  const treeOwner = linkedTreeOwner(owner, source);
  return (
    <OpenOriginContext value={{ kind: "shown", owner, tab }}>
      <PanelLinkOwnerContext value={treeOwner}>
        <Suspense fallback={null}>
          <FilePreviewPanel
            key={`${source.environmentId}:${attachment ? `attachment:${attachment.id}` : cwd}`}
            environmentId={source.environmentId}
            cwd={cwd}
            projectName={project.title}
            projectId={project.id}
            threadRef={source}
            composerDraftTarget={source}
            keybindings={props.keybindings}
            availableEditors={props.availableEditors}
            openInShortcutEnabled={ownsOpenIn}
            relativePath={entry.relativePath}
            {...(attachment ? { attachment } : {})}
            revealLine={entry.revealLine}
            revealRequestId={entry.revealRequestId}
            revealSurface={entry.reveal}
            onRevealShown={() =>
              useRightPanelStore.getState().updateWorkArea(owner, {
                type: "linked-file-shown",
                tab,
                reveal: entry.revealRequestId,
              })
            }
            onOpenFile={treeOwner.openFile}
            {...(sharesWorkspace
              ? {
                  onNavigateFolder: (path: string, trail: string) =>
                    openLinkedFolder(owner, tab, path, trail),
                }
              : {})}
            folderTrail={undefined}
            onPendingChange={ignore}
            selectedFilePending={false}
            workspaceMutationId={workspaceMutationId}
          />
        </Suspense>
      </PanelLinkOwnerContext>
    </OpenOriginContext>
  );
}
