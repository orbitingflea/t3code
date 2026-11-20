import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { createContext } from "react";

import type { SideChatParentPanel } from "~/lib/sideChatPane";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell, useQuietThreadProjection, useQuietThreadShell } from "~/state/entities";
import { environmentThreadDetails, environmentThreadShells } from "~/state/threads";

import { type ChatFileOpener, sideThreadEmbedding } from "./chatFileOpener";
import { listedAncestor, opensAsChatTab, type ThreadPlace } from "./threadLink.logic";

/** The opener of the chat around a link; null outside a chat, where thread links navigate. */
export const ChatOpenerContext = createContext<ChatFileOpener | null>(null);

// A families server's shell can omit a thread; fall back to its loaded detail.
const placeOf = (thread: ScopedThreadRef): ThreadPlace | null =>
  readThreadShell(thread) ??
  appAtomRegistry.get(environmentThreadDetails.quietThreadAtom(thread))?.projection.thread ??
  null;

export function useThreadPlace(thread: ScopedThreadRef): ThreadPlace | null {
  const shell = useQuietThreadShell(thread);
  const detail = useQuietThreadProjection(shell === null ? thread : null);
  return shell ?? detail?.projection.thread ?? null;
}

const NO_PARENT = Atom.make<ThreadId | null>(null);

// Keyed by `[parent key, owner thread id]`.
const listedParentAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const [parentKey, owner] = JSON.parse(key) as [string, ThreadId];
    const parent = parseScopedThreadKey(parentKey);
    if (parent === null) return null;
    return listedAncestor(
      parent.threadId,
      (threadId) => {
        const thread = scopeThreadRef(parent.environmentId, threadId);
        const place =
          get(environmentThreadShells.quietThreadShellAtom(thread)) ??
          get(environmentThreadDetails.quietThreadAtom(thread))?.projection.thread;
        return place?.lineage ?? null;
      },
      owner,
    );
  }),
);

export function useSideThreadEmbedding(
  threadId: ThreadId,
  parentThreadId: ThreadId | null,
  owner: ScopedThreadRef,
  parentPanel: SideChatParentPanel,
) {
  const listedParent = useAtomValue(
    parentThreadId === null
      ? NO_PARENT
      : listedParentAtom(
          JSON.stringify([
            scopedThreadKey(scopeThreadRef(owner.environmentId, parentThreadId)),
            owner.threadId,
          ]),
        ),
  );
  return sideThreadEmbedding(threadId, listedParent, owner, parentPanel);
}

export const placeableInWorkArea = (owner: ScopedThreadRef, thread: ScopedThreadRef): boolean =>
  opensAsChatTab(owner, placeOf(owner), thread, placeOf(thread));

/** Returns true when `target` opens as a work-area Chat tab; false means navigate instead. */
export function openThreadTab(opener: ChatFileOpener | null, target: ScopedThreadRef): boolean {
  const chat = opener?.();
  return chat !== undefined && placeableInWorkArea(chat.panel(), target) && chat.openThread(target);
}

/** Opens `target` as a Chat tab on a plain primary click; returns true if it handled the click. */
export function openThreadTabOnClick(
  event: {
    readonly button: number;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly preventDefault: () => void;
  },
  opener: ChatFileOpener | null,
  target: ScopedThreadRef,
): boolean {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  if (!openThreadTab(opener, target)) return false;
  event.preventDefault();
  return true;
}
