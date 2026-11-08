import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AssistantCitationChip } from "../../components/chat/AssistantCitationChip";
import { render } from "../../../test/render";

const quote = (messageId: string) => ({
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make(messageId),
  text: "Pick A",
  start: 0,
  end: 6,
  prefix: "",
  suffix: "",
});

const cases = [
  { source: "a message", messageId: "message-1", navigable: true },
  { source: "a Dashboard slot", messageId: "dashboard-slot-decide", navigable: false },
];

describe("a quote chip", () => {
  it.each(cases)(
    "for $source in a sent message offers Go to source: $navigable",
    async ({ messageId, navigable }) => {
      await using screen = await render(<AssistantCitationChip citation={quote(messageId)} />);
      await userEvent.click(
        screen.getByRole("button", { name: "Quoted assistant text: Pick A. Show details" }),
      );
      await expect.element(page.getByRole("blockquote")).toHaveTextContent("Pick A");

      expect(page.getByText("Go to source").query() !== null).toBe(navigable);
    },
  );

  it.each(cases)(
    "for $source in the composer links its label to the source: $navigable",
    async ({ messageId, navigable }) => {
      await using screen = await render(
        <AssistantCitationChip citation={quote(messageId)} composer />,
      );

      expect(screen.container.querySelector("a") !== null).toBe(navigable);
      expect(screen.container.textContent).toContain("Pick A");
    },
  );
});
