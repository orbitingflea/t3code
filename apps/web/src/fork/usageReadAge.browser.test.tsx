import { EnvironmentId, ProviderDriverKind, UsageLimitSourceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { UsageLimitsPooled } from "../components/usage/UsageLimitsPooled";

describe("UsageLimitsPooled usage source accounts", () => {
  it("shows a kept reading's time only on windows from that reading", async () => {
    const now = Date.parse("2026-11-03T14:00:00.000Z");
    const readAt = "2026-11-03T11:24:32.000Z";
    const account = (
      id: string,
      email: string,
      windows: ReadonlyArray<{ readonly id: string; readonly readAt?: string }>,
    ) => ({
      id,
      driver: ProviderDriverKind.make("claudeAgent"),
      email,
      plan: "Claude Subscription",
      usageLimits: {
        checkedAt: "2026-11-03T14:00:00.000Z",
        windows: windows.map((window) => ({
          ...window,
          kind: window.id === "five_hour" ? ("session" as const) : ("weekly" as const),
          label: window.id === "five_hour" ? "Session" : "Weekly",
          usedPercent: window.id === "five_hour" ? 40 : 77,
        })),
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
                label: "usage source",
                checkedAt: "2026-11-03T14:00:00.000Z",
                accounts: [
                  // A running session refreshed the weekly window; the session window is still the reading's.
                  account("old.json", "old@example.com", [
                    { id: "five_hour", readAt },
                    { id: "seven_day" },
                  ]),
                  account("fresh.json", "fresh@example.com", [
                    { id: "five_hour", readAt: "2026-11-03T13:58:00.000Z" },
                    { id: "seven_day", readAt: "2026-11-03T13:58:00.000Z" },
                  ]),
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
    // The old session window's bar segment and legend row only.
    expect(screen.getByText("Numbers read", { exact: false }).elements()).toHaveLength(2);
    const [session, weekly] = screen.getByRole("button", { name: /^OE/ }).elements();
    await userEvent.hover(session!);
    await expect.element(screen.getByRole("dialog").getByText("60%")).toBeVisible();
    await expect.element(screen.getByRole("dialog").getByText("As of")).toBeVisible();
    await userEvent.hover(weekly!);
    await expect.element(screen.getByRole("dialog").getByText("23%")).toBeVisible();
    expect(screen.getByText("As of").elements()).toHaveLength(0);
  });
});
