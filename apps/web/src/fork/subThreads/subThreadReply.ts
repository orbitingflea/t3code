import {
  ComposerContextId,
  type OrchestrationMessageContext,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { SUB_THREAD_RECORD_KIND } from "@t3tools/shared/displayModes";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import { forEachSubThreadDraft, subThreadDraftKey } from "./subThreadDraft";

// A slash command, such as `/compact`, acts on the whole thread. A path such as `/usr/bin` is not one.
const COMMAND_TEXT = /^\s*\/[\w-]+(\s|$)/;

/**
 * Returns `context` with the record that makes its message a reply under the first message `first`.
 * No text references the record, so no client draws it and the provider does not get it. A slash
 * command gets no record: it is not part of any sub-thread's talk.
 */
export function withSubThreadRecord(
  first: string | null,
  text: string,
  context: OrchestrationMessageContext | undefined,
): OrchestrationMessageContext | undefined {
  if (first === null || COMMAND_TEXT.test(text)) return context;
  return {
    version: 1,
    records: [
      ...(context?.records ?? []),
      {
        version: 1,
        contextId: ComposerContextId.make("fork-reply"),
        kind: SUB_THREAD_RECORD_KIND,
        label: "Reply",
        payload: { first },
      },
    ],
  };
}

/** The `context` field of a message that the app writes for the user, such as Resume's. */
export const replyContextField = (first: string | null) => {
  const context = withSubThreadRecord(first, "", undefined);
  return context === undefined ? {} : { context };
};

/** Whether `context` holds anything that the user added: any record but the reply's own. */
export const addsContext = (context: OrchestrationMessageContext | undefined): boolean =>
  context?.records.some((record) => record.kind !== SUB_THREAD_RECORD_KIND) === true;

/** Why a reply box does not edit a queued message: the thread keeps one edit, in the main box. */
export const REPLY_BOX_QUEUE_EDIT_BLOCKED = "Edit a queued message from the main message box.";

/**
 * The draft of a sub-thread's reply box, or null for the main list. It holds the box's text and
 * attachments; the model and the modes are the thread's (subThreadDraft.ts). It takes the thread's
 * key: a ref passed through a helper stops the React compiler from keeping the ref stable.
 */
export const subThreadDraftId = (threadKey: string, first: string | null) =>
  first === null ? null : DraftId.make(subThreadDraftKey(threadKey, first));

/** Gives up the uploads that the reply box drafts of the thread `target` hold. */
export function releaseSubThreadDraftUploads(target: ScopedThreadRef | DraftId): void {
  const { draftsByThreadKey } = useComposerDraftStore.getState();
  forEachSubThreadDraft(draftsByThreadKey, target, (key) => {
    const draft = draftsByThreadKey[key];
    if (draft) releaseDraftAttachments([...draft.images, ...draft.files]);
  });
}
