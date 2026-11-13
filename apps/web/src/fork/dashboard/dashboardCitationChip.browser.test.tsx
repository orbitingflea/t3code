import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import {
  AssistantCitationChip,
  AssistantCitationEmbed,
} from "../../components/chat/AssistantCitationChip";
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
    "for $source in a sent message goes to the source: $navigable",
    async ({ messageId, navigable }) => {
      await using screen = await render(
        <AssistantCitationEmbed citation={quote(messageId)} leading trailing />,
      );
      const card = screen.container.querySelector("a")!;

      expect(card.hasAttribute("href")).toBe(navigable);
      expect(card.getAttribute("aria-disabled") === "true").toBe(!navigable);
    },
  );

  it.each(cases)(
    "for $source in the composer links its label to the source: $navigable",
    async ({ messageId, navigable }) => {
      await using screen = await render(<AssistantCitationChip citation={quote(messageId)} />);

      expect(screen.container.querySelector("a") !== null).toBe(navigable);
      expect(screen.container.textContent).toContain("Pick A");
    },
  );
});
