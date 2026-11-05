import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_SERVER_SETTINGS } from "../settings.ts";
import {
  COMPACT_IDLE_CHOICES,
  compactIdleChoice,
  compactIdleChoicePatch,
} from "./compactIdleChoice.ts";

describe("compact idle threads choice", () => {
  it.each(COMPACT_IDLE_CHOICES.map((choice) => choice.value))(
    "reads back %s after writing it",
    (choice) => {
      for (const before of [false, true]) {
        const settings = { ...DEFAULT_SERVER_SETTINGS, compactWhenIdle: before };
        expect(compactIdleChoice({ ...settings, ...compactIdleChoicePatch(choice) })).toBe(choice);
      }
    },
  );

  it.each([
    { stored: { compactIdleThreads: true }, choice: "whenIdle" },
    { stored: { compactIdleThreads: "beforeCacheExpires" }, choice: "whenIdle" },
    { stored: { compactIdleThreads: false }, choice: "onReturn" },
    { stored: { compactIdleThreads: "off" }, choice: "off" },
    { stored: { compactIdleThreads: true, idleCompaction: "onReturn" }, choice: "onReturn" },
  ] as const)("reads $choice from $stored with compactWhenIdle on", ({ stored, choice }) => {
    const { idleCompaction: _unset, ...defaults } = DEFAULT_SERVER_SETTINGS;
    expect(compactIdleChoice({ ...defaults, ...stored, compactWhenIdle: true })).toBe(choice);
  });
});
