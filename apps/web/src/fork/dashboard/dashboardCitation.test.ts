import {
  type AssistantCitation,
  DASHBOARD_SLOT_IDS,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import {
  formatAssistantCitationHref,
  parseAssistantCitationHref,
} from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  dashboardCitationSourceProps,
  isDashboardCitation,
  timelineCitation,
} from "./dashboardCitation";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

const quote = (messageId: string): AssistantCitation => ({
  version: 1,
  ...threadRef,
  messageId: MessageId.make(messageId),
  text: "Pick A",
  start: 0,
  end: 6,
  prefix: "",
  suffix: " or B",
  comment: "A, please",
});

describe("a Dashboard quote", () => {
  it.each(DASHBOARD_SLOT_IDS)("names slot %s in the link the agent reads", (slot) => {
    const source = dashboardCitationSourceProps(threadRef, slot)["data-assistant-citation-source"];
    const href = formatAssistantCitationHref(quote(source));

    expect(href).toContain(`/environment/thread/dashboard-slot-${slot}?`);
    const parsed = parseAssistantCitationHref(href);
    expect(parsed).toEqual(quote(source));
    expect(timelineCitation(parsed)).toBeNull();
  });

  it("keeps every id in the reserved namespace out of the timeline", () => {
    expect(timelineCitation(quote("dashboard-slot-x"))).toBeNull();
  });

  it.each([
    "6f1c2a0e-6c55-4f43-9d1b-1d2f0b9c4e7a",
    "message:6f1c2a0e-6c55-4f43-9d1b-1d2f0b9c4e7a",
    "turn-item:send",
  ])("leaves the message quote %s to the timeline", (messageId) => {
    const citation = quote(messageId);
    expect(isDashboardCitation(citation)).toBe(false);
    expect(timelineCitation(citation)).toBe(citation);
  });
});
