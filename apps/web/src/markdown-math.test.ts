import { describe, expect, it } from "vite-plus/test";

import { normalizeChatMath } from "./markdown-math";

describe("normalizeChatMath", () => {
  it.each([
    ["\\[x+y\\]\n$$z$$", "$$\nx+y\n$$\n$$\nz\n$$"],
    [
      "math $x^2+1$ and $$\\sum_{i=1}^n i$$ reply ok",
      "math $x^2+1$ and \n\n$$\n\\sum_{i=1}^n i\n$$\n\n reply ok",
    ],
    ["before\n\\[\nx=\\pm i\n\\]\nafter", "before\n$$\nx=\\pm i\n$$\nafter"],
    ["Inline \\(x^2=-1\\) and \\[y=\\pm i\\]", "Inline $x^2=-1$ and \n\n$$\ny=\\pm i\n$$\n\n"],
  ])("normalizes chat math in %s", (markdown, expected) => {
    expect(normalizeChatMath(markdown)).toBe(expected);
  });

  it("does not parse paired prices as math", () => {
    expect(normalizeChatMath("Prices are $5 and $3 today.")).toBe(
      "Prices are \\$5 and \\$3 today.",
    );
    expect(normalizeChatMath("The total is $12.50 today.")).toBe("The total is \\$12.50 today.");
  });

  it("does not alter math-like text in fenced or inline code", () => {
    const markdown = ["```txt", "~~~", "\\(x\\)", "```", "``code ` \\(y\\)`` and \\(z\\)"].join(
      "\n",
    );
    expect(normalizeChatMath(markdown)).toBe(
      ["```txt", "~~~", "\\(x\\)", "```", "``code ` \\(y\\)`` and $z$"].join("\n"),
    );
  });

  it("does not alter math-like text in link destinations or HTML tags", () => {
    const markdown =
      '[docs](https://example.com/\\(intro\\)) <a href="/\\(raw\\)">link</a> \\(x\\)';
    expect(normalizeChatMath(markdown)).toBe(
      '[docs](https://example.com/\\(intro\\)) <a href="/\\(raw\\)">link</a> $x$',
    );
  });

  it("does not parse slash-suffixed prices as math", () => {
    expect(normalizeChatMath("Plans cost $5/month or $10/month")).toBe(
      "Plans cost \\$5/month or \\$10/month",
    );
  });
});
