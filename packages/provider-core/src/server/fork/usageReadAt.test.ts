import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "../usageLimits.ts";

const session = { id: "five_hour", kind: "session", label: "Session", usedPercent: 10 } as const;
const weekly = { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 30 } as const;
const readAt = "2026-09-03T09:00:00.000Z";
const fromSource = {
  checkedAt: "2026-09-03T12:00:00.000Z",
  readAt,
  windows: [session, weekly],
};
const runtimeAt = "2026-09-03T12:00:05.000Z";
const runtimeSession = { ...session, usedPercent: 40 };

describe("a runtime update to limits read from a usage source", () => {
  it("keeps the reading time while the update leaves a window from the reading", () => {
    expect(
      applyUsageLimitsUpdate({
        previous: fromSource,
        update: { windows: [runtimeSession] },
        checkedAt: runtimeAt,
      }),
    ).toEqual({ checkedAt: runtimeAt, readAt, windows: [runtimeSession, weekly] });
  });

  it("drops the reading time when the update reports every window", () => {
    const runtimeWeekly = { ...weekly, usedPercent: 50 };
    expect(
      applyUsageLimitsUpdate({
        previous: fromSource,
        update: { windows: [runtimeSession, runtimeWeekly] },
        checkedAt: runtimeAt,
      }),
    ).toEqual({ checkedAt: runtimeAt, windows: [runtimeSession, runtimeWeekly] });
  });

  it("drops the reading time when the update reports every window unchanged", () => {
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
  const probed = {
    checkedAt: "2026-09-03T12:00:01.000Z",
    readAt: "2026-09-03T10:00:00.000Z",
    windows: [session, weekly],
  };

  it("keeps the published reading time when runtime windows replaced only some windows", () => {
    const published = applyUsageLimitsUpdate({
      previous: fromSource,
      update: { windows: [runtimeSession] },
      checkedAt: runtimeAt,
    });
    expect(resolveUsageLimitsAfterProbe({ published, probed })).toEqual({
      checkedAt: runtimeAt,
      readAt,
      windows: [runtimeSession, weekly],
    });
  });

  it("drops the reading time when runtime windows replaced every window", () => {
    const published = { checkedAt: runtimeAt, windows: [runtimeSession] };
    expect(resolveUsageLimitsAfterProbe({ published, probed })).toEqual({
      checkedAt: runtimeAt,
      windows: [runtimeSession],
    });
  });
});
