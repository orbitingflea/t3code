import { describe, expect, it } from "vite-plus/test";

import { TEXT_MATCH_MIN_RATIO, textSimilarity, visibleText } from "./textMatch.ts";

describe("visibleText", () => {
  it("drops tags, keeps link labels and collapses whitespace", () => {
    expect(visibleText("  <b>See</b>\n\n[the docs](https://example.com/a)\tnow ")).toBe(
      "See the docs now",
    );
  });
});

describe("textSimilarity", () => {
  const base = "- PR 12: waiting on CI\n- PR 13: needs a review from the user";
  it.each([
    ["the same text", base, base, true],
    ["the same visible text in other markup", base, `${base.replaceAll("\n", "\n\n")}  `, true],
    ["a small edit", base, base.replace("PR 13", "PR 14"), true],
    ["a big change", base, "- PR 12: merged", false],
    ["two empty texts", "", "  ", true],
    ["an empty slot against a non-empty old text", "", "PR 12", false],
    [
      "Chinese text with one character changed",
      "等待你决定是否合并这个改动以及后续的计划",
      "等待你决定是否合并这个改动以及之后的计划",
      true,
    ],
    ["Chinese text rewritten", "等待你决定是否合并这个改动", "已经合并完成", false],
    ["a change of case only", "Yes", "yes", true],
    ["full-width letters against half-width ones", "ＡＢＣ", "abc", true],
    ["texts exactly 70% alike", "abcdefghij", "abcdefgxyz", true],
    ["texts 60% alike", "abcdefghij", "abcdefxyzw", false],
  ])("%s", (_name, current, old, accepted) => {
    expect(textSimilarity(current, old) >= TEXT_MATCH_MIN_RATIO).toBe(accepted);
  });

  it("ignores case and width", () => {
    expect(textSimilarity("Yes", "yes")).toBe(1);
    expect(textSimilarity("ＡＢＣ", "abc")).toBe(1);
  });

  it("counts characters as code points", () => {
    expect(textSimilarity("😀a", "😀b")).toBe(0.5);
  });
});
