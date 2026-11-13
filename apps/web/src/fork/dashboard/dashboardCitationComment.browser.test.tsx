import {
  type AssistantCitation,
  DASHBOARD_SLOT_IDS,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { type ComponentProps, createRef, type RefObject, useState } from "react";
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
  readonly layout: "side panel" | "sheet" | "side panel, inert composer";
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly onCloseSheet: () => void;
}) {
  const [prompt, setPrompt] = useState(`See ${serializeAssistantCitation(props.quote)} `);
  const [cursor, setCursor] = useState(0);
  const dashboardQuote = props.quote.messageId.startsWith("dashboard-slot-");
  const editor = (
    <ComposerPromptEditor
      editorRef={props.editorRef}
      value={prompt}
      cursor={cursor}
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder=""
      onChange={(nextPrompt, nextCursor) => {
        setPrompt(nextPrompt);
        setCursor(nextCursor);
      }}
      onCitationDraftSave={(replacedValue, savedValue) => {
        if (replacedValue === prompt) setPrompt(savedValue);
      }}
      onCitationSubmitAndSend={() => {
        setPrompt("");
        return true;
      }}
      onPaste={() => {}}
    />
  );
  const cards = (
    <DashboardCards
      threadRef={threadRef}
      dashboard={dashboard}
      onMarkSeen={() => {}}
      onCite={() => true}
    />
  );
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
      {props.layout === "side panel, inert composer" ? <div inert>{editor}</div> : editor}
      {!dashboardQuote ? null : props.layout === "sheet" ? (
        <RightPanelSheet animationDurationMs={0} open onClose={props.onCloseSheet}>
          {cards}
        </RightPanelSheet>
      ) : (
        cards
      )}
    </>
  );
}

const focusIn = {
  card: () => document.querySelector<HTMLElement>('[data-slot="decide"]')!,
  composer: () => document.querySelector<HTMLElement>(".ProseMirror")!,
};

async function renderComposer(
  quote: AssistantCitation,
  layout: ComponentProps<typeof Composer>["layout"],
) {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const onCloseSheet = vi.fn();
  const composer = (key: string) => (
    <Composer
      key={key}
      quote={quote}
      layout={layout}
      editorRef={editorRef}
      onCloseSheet={onCloseSheet}
    />
  );
  const screen = await render(null);
  const prompt = () => screen.container.querySelector("output")!.dataset.prompt;
  /** Mounts a composer under `key`, so the quote is fresh, and opens its comment box. */
  const openComment = async (key: string) => {
    await screen.rerender(composer(key));
    // The modal sheet moves focus into itself once it mounts, which would take it from the box.
    if (layout === "sheet") await expect.element(page.getByRole("dialog")).toHaveFocus();
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
    await expect.element(page.getByLabelText("Comment on selected text")).toHaveFocus();
  };
  return { ...screen, prompt, openComment, onCloseSheet };
}

describe("closing a fresh quote's comment box", () => {
  it.each([
    {
      source: "a Dashboard slot in the side panel",
      messageId: "dashboard-slot-decide",
      layout: "side panel",
      afterSave: "composer",
      afterEscape: "card",
    },
    {
      source: "a Dashboard slot in the sheet",
      messageId: "dashboard-slot-decide",
      layout: "sheet",
      afterSave: "card",
      afterEscape: "card",
    },
    {
      source: "a Dashboard slot in the side panel while the composer is inert",
      messageId: "dashboard-slot-decide",
      layout: "side panel, inert composer",
      afterSave: "card",
      afterEscape: "card",
    },
    {
      source: "a message",
      messageId: "message-1",
      layout: "side panel",
      afterSave: "composer",
      afterEscape: "composer",
    },
  ] as const)(
    "on $source gives focus to the $afterSave after Enter or Save, and to the $afterEscape after Escape, which drops the quote",
    async ({ messageId, layout, afterSave, afterEscape }) => {
      const quote = quoteOf(messageId);
      await using screen = await renderComposer(quote, layout);

      for (const save of ["Enter", "Save button"] as const) {
        await screen.openComment(save);
        await userEvent.keyboard("A, please");
        if (save === "Enter") await userEvent.keyboard("{Enter}");
        else await page.getByRole("button", { name: "Save", exact: true }).click();
        await vi.waitFor(() => expect(document.activeElement).toBe(focusIn[afterSave]()));
        expect(screen.prompt()).toContain("comment=A%2C+please");
        if (afterSave === "composer") {
          await userEvent.keyboard(" xyz");
          await vi.waitFor(() =>
            expect(screen.prompt()).toContain(
              `${serializeAssistantCitation({ ...quote, comment: "A, please" })} xyz`,
            ),
          );
        }
      }

      await screen.openComment("Escape");
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(document.activeElement).toBe(focusIn[afterEscape]()));
      expect(screen.prompt()).not.toContain("t3-citation");
      expect(screen.onCloseSheet).not.toHaveBeenCalled();
    },
  );
});

describe("saving a quote's comment and sending the message", () => {
  it.each([
    { source: "a Dashboard slot in the side panel", layout: "side panel", focus: "composer" },
    { source: "a Dashboard slot in the sheet", layout: "sheet", focus: "card" },
  ] as const)("on $source gives focus to the $focus", async ({ layout, focus }) => {
    await using screen = await renderComposer(quoteOf("dashboard-slot-decide"), layout);

    await screen.openComment("send");
    await userEvent.keyboard("A, please{Control>}{Enter}{/Control}");
    await vi.waitFor(() => expect(document.activeElement).toBe(focusIn[focus]()));
    expect(screen.prompt()).toBe("");
    expect(screen.onCloseSheet).not.toHaveBeenCalled();
  });
});
