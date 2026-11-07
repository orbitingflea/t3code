import { describe, expect, it } from "vite-plus/test";

import { visibleUnits } from "./visibleUnits.ts";

describe("visibleUnits", () => {
  // Basic counting cases first, then cases where JavaScript's regex classes differ from Python's.
  it.each([
    ["ab 12", 4],
    ["中文", 6],
    ["**a** | `b` # - ,.!?", 2],
    ["see https://example.com/x?y=1 <b>ok</b>", 5],
    ["[link](https://example.com)", 4],
    ["1. one\n2. two", 6],
    ["  3. item\n\n10. last", 8],
    ["a\r1. b", 3],
    ["x﻿y", 3],
    ["a\u001cb", 2],
    ["全角ＡＢ", 12],
    ["١. ٢", 1],
    ["😀 ok", 2],
    ["https://a.example/中文 tail", 4],
    ["![alt](x.png)", 3],
  ])("counts %j as %i", (text, units) => {
    expect(visibleUnits(text)).toBe(units);
  });
});
