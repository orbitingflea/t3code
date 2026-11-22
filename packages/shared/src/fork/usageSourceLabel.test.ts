import { EnvironmentId, ProviderDriverKind, UsageLimitSourceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectLimitNotices } from "../usageLimitsCopy.ts";

describe("usage source account labels", () => {
  it("names a failed hub account's notice by its label, as its row", () => {
    const failed = (id: string, workspaceId: string, label: string) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      email: "a@example.com",
      label,
      workspaceId,
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        unavailable: { reason: "probeFailed" as const, message: "HTTP 429." },
      },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          entry: { target: { label: "Laptop" } },
          serverConfig: {
            providers: [],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy" as const,
                label: "hub",
                checkedAt: "2026-09-03T11:00:00.000Z",
                accounts: [failed("work", "ws-1", "Work"), failed("home", "ws-2", "Home")],
              },
            ],
          },
        },
      ],
    ]);
    expect(collectLimitNotices(input)).toEqual(["hub · Work: HTTP 429.", "hub · Home: HTTP 429."]);
  });
});
