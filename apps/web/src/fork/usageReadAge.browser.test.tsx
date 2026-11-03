import { EnvironmentId, ProviderDriverKind, UsageLimitSourceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { UsageLimitsPooled } from "../components/usage/UsageLimitsPooled";

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
