import { describe, expect, it } from "vite-plus/test";

import { oldReadingAt } from "./usageReadAge";

describe("oldReadingAt", () => {
  const now = Date.parse("2026-11-03T14:00:00Z");
  const window = { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 } as const;

  it("names a reading a usage source kept serving after failed reads", () => {
    const readAt = "2026-11-03T11:24:32.000Z";
    expect(oldReadingAt({ ...window, readAt }, now)).toBe(readAt);
  });

  it("names a reading just over 20 minutes old", () => {
    const readAt = "2026-11-03T13:39:00.000Z";
    expect(oldReadingAt({ ...window, readAt }, now)).toBe(readAt);
  });

  it("stays quiet for a reading up to 20 minutes old or one without a time", () => {
    expect(oldReadingAt({ ...window, readAt: "2026-11-03T13:41:00.000Z" }, now)).toBeNull();
    expect(oldReadingAt({ ...window, readAt: "2026-11-03T13:40:00.000Z" }, now)).toBeNull();
    expect(oldReadingAt(window, now)).toBeNull();
  });
});
