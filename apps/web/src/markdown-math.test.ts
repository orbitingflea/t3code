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
    ["Inline \\(x^2=-1\\)", "Inline $x^2=-1$"],
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

  it("does not pair common price contexts into math", () => {
    expect(normalizeChatMath("$5-$10, ($5 off), $5%, and $5: each")).toBe(
      "\\$5-\\$10, (\\$5 off), \\$5%, and \\$5: each",
    );
  });

  it("normalizes multiple display spans on one line separately", () => {
    expect(normalizeChatMath("$$a$$ and $$b$$")).toBe("\n\n$$\na\n$$\n\n and \n\n$$\nb\n$$\n\n");
  });

  it("normalizes math in prose comparisons", () => {
    expect(normalizeChatMath("for 0 < x, \\(x^2\\) grows when x > 1")).toBe(
      "for 0 < x, $x^2$ grows when x > 1",
    );
  });

  it("does not alter indented code or blockquote fenced code", () => {
    const markdown = [
      "    code block \\(x\\) indented",
      "> ```txt",
      "> \\(y\\)",
      "> ```",
      "after \\(z\\)",
    ].join("\n");
    expect(normalizeChatMath(markdown)).toBe(
      ["    code block \\(x\\) indented", "> ```txt", "> \\(y\\)", "> ```", "after $z$"].join("\n"),
    );
  });

  it("only treats bracket math as display math when it stands alone", () => {
    // Inline bracket escapes are commonly emitted as citations, so only a
    // whole-line \\[…] span is interpreted as display math.
    expect(normalizeChatMath("See \\[1\\] for details\n\\[x+y\\]")).toBe(
      "See \\[1\\] for details\n$$\nx+y\n$$",
    );
  });
});
