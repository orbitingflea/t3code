import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "../usageLimits.ts";

const readAt = "2026-09-03T09:00:00.000Z";
const session = { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 } as const;
const weekly = { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 30 } as const;
const fromSource = {
  checkedAt: "2026-09-03T12:00:00.000Z",
  windows: [
    { ...session, readAt },
    { ...weekly, readAt },
  ],
};
const runtimeAt = "2026-09-03T12:00:05.000Z";
const runtimeSession = { ...session, usedPercent: 40 };
const runtimeWeekly = { ...weekly, usedPercent: 50 };

describe("a runtime update to limits read from a usage source", () => {
  it("keeps the reading time only on windows the update leaves out", () => {
    expect(
      applyUsageLimitsUpdate({
        previous: fromSource,
        update: { windows: [runtimeSession] },
        checkedAt: runtimeAt,
      }),
    ).toEqual({ checkedAt: runtimeAt, windows: [runtimeSession, { ...weekly, readAt }] });
  });

  it("drops the reading time once updates one window at a time report every window", () => {
    const afterSession = applyUsageLimitsUpdate({
      previous: fromSource,
      update: { windows: [runtimeSession] },
      checkedAt: runtimeAt,
    });
    expect(
      applyUsageLimitsUpdate({
        previous: afterSession,
        update: { windows: [runtimeWeekly] },
        checkedAt: "2026-09-03T12:00:09.000Z",
      }),
    ).toEqual({
      checkedAt: "2026-09-03T12:00:09.000Z",
      windows: [runtimeSession, runtimeWeekly],
    });
  });

  it("drops the reading time from windows the update reports unchanged", () => {
    expect(
      applyUsageLimitsUpdate({
        previous: fromSource,
        update: { windows: [session, weekly] },
        checkedAt: runtimeAt,
      }),
    ).toEqual({ checkedAt: fromSource.checkedAt, windows: [session, weekly] });
  });
});

describe("resolveUsageLimitsAfterProbe with a usage source's reading time", () => {
  const probedAt = "2026-09-03T10:00:00.000Z";
  const probed = {
    checkedAt: "2026-09-03T12:00:01.000Z",
    windows: [
      { ...session, readAt: probedAt },
      { ...weekly, readAt: probedAt },
    ],
  };

  it("keeps the reading time of published windows no runtime update replaced", () => {
    const published = applyUsageLimitsUpdate({
      previous: fromSource,
      update: { windows: [runtimeSession] },
      checkedAt: runtimeAt,
    });
    expect(resolveUsageLimitsAfterProbe({ published, probed })).toEqual({
      checkedAt: runtimeAt,
      windows: [runtimeSession, { ...weekly, readAt }],
    });
  });
});
