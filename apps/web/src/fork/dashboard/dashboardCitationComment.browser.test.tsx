import {
  type AssistantCitation,
  DASHBOARD_SLOT_IDS,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { createRef, type RefObject, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../../components/ComposerPromptEditorTiptap";
import { RightPanelSheet } from "../../components/RightPanelSheet";
import { findAssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";
import { act, render } from "../../../test/render";
import { DashboardCards } from "./ThreadDashboardPanel";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

const quoteOf = (messageId: string): AssistantCitation => ({
  version: 1,
  ...threadRef,
  messageId: MessageId.make(messageId),
  text: "Pick A",
  start: 0,
  end: 6,
  prefix: "",
  suffix: "",
});

const dashboard = {
  threadId: threadRef.threadId,
  slots: DASHBOARD_SLOT_IDS.map((slot) => ({
    slot,
    text: slot === "decide" ? "Pick A or B" : "",
    updatedAt: null,
    seenText: slot === "decide" ? "Pick A or B" : null,
  })),
};

function Composer(props: {
  readonly quote: AssistantCitation;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly onCloseSheet: () => void;
}) {
  const [prompt, setPrompt] = useState(`See ${serializeAssistantCitation(props.quote)} `);
  const dashboardQuote = props.quote.messageId.startsWith("dashboard-slot-");
  return (
    <>
      {dashboardQuote ? null : (
        <div data-assistant-citation-viewport="">
          <p
            data-assistant-citation-source={props.quote.messageId}
            data-assistant-citation-environment={threadRef.environmentId}
            data-assistant-citation-thread={threadRef.threadId}
          >
            Pick A or B
          </p>
        </div>
      )}
      <output data-prompt={prompt} />
      <ComposerPromptEditor
        editorRef={props.editorRef}
        value={prompt}
        cursor={0}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={setPrompt}
        onCitationDraftSave={(replacedValue, savedValue) => {
          if (replacedValue === prompt) setPrompt(savedValue);
        }}
        onPaste={() => {}}
      />
      {dashboardQuote ? (
        <RightPanelSheet animationDurationMs={0} open onClose={props.onCloseSheet}>
          <DashboardCards
            threadRef={threadRef}
            dashboard={dashboard}
            onMarkSeen={() => {}}
            onCite={() => true}
          />
        </RightPanelSheet>
      ) : null}
    </>
  );
}

const focusIn = {
  card: () => document.querySelector<HTMLElement>('[data-slot="decide"]')!,
  composer: () => document.querySelector<HTMLElement>(".ProseMirror")!,
};

describe("closing a fresh quote's comment box", () => {
  it.each([
    { source: "a Dashboard slot", messageId: "dashboard-slot-decide", focus: "card" },
    { source: "a message", messageId: "message-1", focus: "composer" },
  ] as const)(
    "on $source gives focus to the $focus after Save, and after Escape drops the quote",
    async ({ messageId, focus }) => {
      const quote = quoteOf(messageId);
      const editorRef = createRef<ComposerPromptEditorHandle>();
      const onCloseSheet = vi.fn();
      await using screen = await render(
        <Composer quote={quote} editorRef={editorRef} onCloseSheet={onCloseSheet} />,
      );
      const prompt = () => screen.container.querySelector("output")!.dataset.prompt;
      const openComment = async () => {
        const sourceAnchor = await vi.waitFor(() => {
          const anchor = findAssistantCitationSourceAnchor(document, quote);
          expect(anchor).not.toBeNull();
          return anchor!;
        });
        await act(async () =>
          editorRef.current?.requestCitationComment({
            previousValue: "See ",
            value: prompt()!,
            citationStart: "See ".length,
            sourceAnchor,
            insertedSpaces: { before: false, after: true },
          }),
        );
        const comment = page.getByLabelText("Comment on selected text");
        await expect.element(comment).toHaveFocus();
        return comment;
      };

      await openComment();
      await userEvent.keyboard("A, please{Enter}");
      await vi.waitFor(() => expect(document.activeElement).toBe(focusIn[focus]()));
      expect(prompt()).toContain("comment=A%2C+please");

      await screen.rerender(
        <Composer key="fresh" quote={quote} editorRef={editorRef} onCloseSheet={onCloseSheet} />,
      );
      await openComment();
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(document.activeElement).toBe(focusIn[focus]()));
      expect(prompt()).not.toContain("t3-citation");
      expect(onCloseSheet).not.toHaveBeenCalled();
    },
  );
});
