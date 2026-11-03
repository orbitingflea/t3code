import { describe, expect, it } from "vite-plus/test";

import { resolveUsageLimitsAfterProbe } from "../usageLimits.ts";

describe("resolveUsageLimitsAfterProbe with a usage source's reading time", () => {
  it("drops the reading time when runtime windows are newer", () => {
    const session = {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 40,
    } as const;
    const live = { checkedAt: "2026-09-03T12:00:05.000Z", windows: [session] };
    const probed = {
      checkedAt: "2026-09-03T12:00:00.000Z",
      readAt: "2026-09-03T09:00:00.000Z",
      windows: [{ ...session, usedPercent: 10 }],
    };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toEqual({
      checkedAt: live.checkedAt,
      windows: live.windows,
    });
  });
});
