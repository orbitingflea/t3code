import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EditorId, ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { lazy, Suspense } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useProject, useQuietThreadShell } from "~/state/entities";
import { environmentThreadDetails } from "~/state/threads";

import { OpenOriginContext, openLinkedFolder } from "./chatFileOpener";
import type { LinkedFileEntry, TabId } from "./workArea.logic";

const FilePreviewPanel = lazy(() => import("~/components/files/FilePreviewPanel"));

const ignore = () => {};

function useThreadWorkspace(thread: ScopedThreadRef) {
  const shell = useQuietThreadShell(thread);
  const project = useProject(shell ? scopeProjectRef(shell.environmentId, shell.projectId) : null);
  return shell === null || project === null
    ? null
    : { project, cwd: shell.worktreePath ?? project.workspaceRoot };
}

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
  if (workspace === null) return null;
  const { project, cwd } = workspace;
  const sharesWorkspace =
    source.environmentId === owner.environmentId && ownerWorkspace?.cwd === cwd;
  return (
    <OpenOriginContext value={{ kind: "shown", owner, tab }}>
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
          openInShortcutEnabled={false}
          relativePath={entry.relativePath}
          {...(attachment ? { attachment } : {})}
          revealLine={entry.revealLine}
          revealRequestId={entry.revealRequestId}
          revealSurface={entry}
          onOpenFile={(path) =>
            useRightPanelStore
              .getState()
              .updateWorkArea(owner, { type: "link-file", source, path, line: null })
          }
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
    </OpenOriginContext>
  );
}
