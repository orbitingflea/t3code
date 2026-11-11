import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import type { ComposerThreadDraftState, DraftId } from "../../composerDraftStore";

const MARK = ":sub-thread:";

/**
 * The key of the draft of a sub-thread's reply box. It starts with the environment's id, as a
 * thread's own draft key does, so the cleanup of a removed environment finds it.
 */
export function subThreadDraftKey(threadKey: string, first: string): string {
  const cut = threadKey.indexOf(":");
  return `${threadKey.slice(0, cut)}${MARK}${encodeURIComponent(first)}:${threadKey.slice(cut + 1)}`;
}

/** The thread whose reply box has the draft `key`; null when `key` is not a sub-thread's draft. */
export function threadOfSubThreadDraft(key: string): ScopedThreadRef | null {
  const cut = key.indexOf(":");
  if (cut <= 0 || !key.startsWith(MARK, cut)) return null;
  const rest = key.slice(cut + MARK.length);
  const end = rest.indexOf(":");
  if (end < 0 || end === rest.length - 1) return null;
  return {
    environmentId: key.slice(0, cut) as EnvironmentId,
    threadId: rest.slice(end + 1) as ThreadId,
  };
}

/**
 * Calls `each` with the draft id of every reply box of the thread `target`. A thread that is gone
 * takes those drafts with it. A draft id as `target` has no reply boxes.
 */
export function forEachSubThreadDraft(
  drafts: Readonly<Record<string, unknown>>,
  target: ScopedThreadRef | string,
  each: (draftId: DraftId) => void,
): void {
  if (typeof target === "string") return;
  for (const key of Object.keys(drafts)) {
    const thread = threadOfSubThreadDraft(key);
    if (thread?.environmentId === target.environmentId && thread.threadId === target.threadId) {
      each(key as DraftId);
    }
  }
}

/** Where a choice made in the composer of `target` is stored: a reply box stores it with its thread. */
export const choiceDraftTarget = <Target extends ScopedThreadRef | string>(
  target: Target,
): Target | ScopedThreadRef =>
  typeof target === "string" ? (threadOfSubThreadDraft(target) ?? target) : target;

// What a thread has one of, whichever box the user sets it in: the model and the modes.
const CHOICES = [
  "activeProvider",
  "modelSelectionByProvider",
  "modelSelectionExplicit",
  "runtimeMode",
  "interactionMode",
] as const satisfies ReadonlyArray<keyof ComposerThreadDraftState>;

const hasChoice = (draft: ComposerThreadDraftState) =>
  draft.activeProvider !== null ||
  Object.keys(draft.modelSelectionByProvider).length > 0 ||
  draft.modelSelectionExplicit === true ||
  draft.runtimeMode !== null ||
  draft.interactionMode !== null;

// The latest view of each reply box's draft. A view keeps its identity while its parts keep theirs,
// so typing in the main box does not redraw the reply box.
const views = new Map<
  string,
  { readonly own: ComposerThreadDraftState | null; readonly view: ComposerThreadDraftState }
>();
const VIEWS_KEPT = 16;

/**
 * The draft that the composer of `key` reads. A reply box's draft holds only what the user typed
 * and attached there; its model and modes are those of its thread's draft, so both boxes show and
 * send the same choice. Any other draft is returned as it is.
 */
export function composerDraftView(
  key: string,
  own: ComposerThreadDraftState | null,
  draftOfThread: (thread: ScopedThreadRef) => ComposerThreadDraftState | null,
  emptyDraft: ComposerThreadDraftState,
): ComposerThreadDraftState | null {
  const thread = threadOfSubThreadDraft(key);
  const choices = thread === null ? null : draftOfThread(thread);
  if (choices === null || (own === null && !hasChoice(choices))) return own;
  const last = views.get(key);
  if (last?.own === own && CHOICES.every((field) => Object.is(last.view[field], choices[field]))) {
    return last.view;
  }
  const view: ComposerThreadDraftState = {
    ...(own ?? emptyDraft),
    activeProvider: choices.activeProvider,
    modelSelectionByProvider: choices.modelSelectionByProvider,
    runtimeMode: choices.runtimeMode,
    interactionMode: choices.interactionMode,
  };
  if (choices.modelSelectionExplicit === true) view.modelSelectionExplicit = true;
  else delete view.modelSelectionExplicit;
  views.delete(key);
  views.set(key, { own, view });
  for (const oldest of views.keys()) {
    if (views.size <= VIEWS_KEPT) break;
    views.delete(oldest);
  }
  return view;
}
