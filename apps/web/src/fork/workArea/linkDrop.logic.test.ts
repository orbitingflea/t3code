import { describe, expect, it } from "vite-plus/test";

import { dropEffectFor } from "./linkDrop.logic";

describe("dropEffectFor", () => {
  it.each([
    ["all", "copy"],
    ["uninitialized", "copy"],
    ["copyMove", "copy"],
    ["copyLink", "copy"],
    ["linkMove", "link"],
    ["link", "link"],
    ["move", "move"],
    ["none", null],
  ])("%s gives %s", (effectAllowed, effect) => {
    expect(dropEffectFor(effectAllowed)).toBe(effect);
  });
});
