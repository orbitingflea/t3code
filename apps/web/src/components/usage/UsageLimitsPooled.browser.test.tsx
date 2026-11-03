import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

describe("UsageLimitsPooled usage source accounts", () => {
  it("shows when a kept reading was read", async () => {
    const now = Date.parse("2026-11-03T14:00:00.000Z");
    const account = (id: string, email: string, readAt: string) => ({
      id,
      driver: ProviderDriverKind.make("claudeAgent"),
      email,
      plan: "Claude Subscription",
      usageLimits: {
        checkedAt: "2026-11-03T14:00:00.000Z",
        readAt,
        windows: [{ id: "session", kind: "session" as const, label: "Session", usedPercent: 40 }],
      },
    });
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy" as const,
                label: "t3switch",
                checkedAt: "2026-11-03T14:00:00.000Z",
                accounts: [
                  account("old.json", "old@example.com", "2026-11-03T11:24:32.000Z"),
                  account("fresh.json", "fresh@example.com", "2026-11-03T13:58:00.000Z"),
                ],
              },
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={now} />,
    );

    await expect.element(screen.getByText("Numbers read 2h ago").first()).toBeVisible();
    // The old account's bar segment and legend row; the fresh account has no tag.
    expect(screen.getByText("Numbers read", { exact: false }).elements()).toHaveLength(2);
    await userEvent.hover(screen.getByRole("button", { name: /^OE/ }).first());
    await expect.element(screen.getByText("As of")).toBeVisible();
  });
});
