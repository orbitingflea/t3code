// Hand-written input/output pairs for mathsplit, decided before running; run with `npm test`.
import { strict as assert } from "node:assert";
import { findMathInputRule, findMathPasteRule, normalizeMath } from "./mathsplit";

// findMathInputRule: fires only when the last $...$ span ends exactly at the end of the text.
const inputRulePairs: Array<[string, ReturnType<typeof findMathInputRule>]> = [
  ["$x$", { index: 0, text: "$x$", replaceWith: "x" }],
  ["a $x^2$", { index: 2, text: "$x^2$", replaceWith: "x^2" }],
  ["$a$ and $b$", { index: 8, text: "$b$", replaceWith: "b" }],
  ["$ x $", { index: 0, text: "$ x $", replaceWith: "x" }],
  ["a $x$ b", null],
  ["$$", null],
  ["$ $", null],
  ["$a\nb$", null],
  ["no math", null],
  ["stray $ alone", null],
];

// findMathPasteRule: every paired non-empty same-line span, in order.
const pasteRulePairs: Array<[string, ReturnType<typeof findMathPasteRule>]> = [
  ["no math", []],
  [
    "a $x$ b $y$",
    [
      { index: 2, text: "$x$", replaceWith: "x" },
      { index: 8, text: "$y$", replaceWith: "y" },
    ],
  ],
  [
    "$a$$b$",
    [
      { index: 0, text: "$a$", replaceWith: "a" },
      { index: 3, text: "$b$", replaceWith: "b" },
    ],
  ],
  // Dollar amounts pair up too — a known consequence of the $...$ convention.
  ["costs $5 or $10", [{ index: 6, text: "$5 or $", replaceWith: "5 or" }]],
];

// normalizeMath: rich-text trees; text nodes split around $...$, everything else preserved.
const mathNode = (latex: string) => ({
  type: "math_inline",
  content: [{ type: "text", text: latex }],
});
const paragraph = (...content: unknown[]) => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
});
const normalizePairs: Array<[unknown, unknown]> = [
  ["plain string", "plain string"],
  [null, null],
  [
    paragraph({ type: "text", text: "no math here" }),
    paragraph({ type: "text", text: "no math here" }),
  ],
  [
    paragraph({ type: "text", text: "a $x$ b" }),
    paragraph({ type: "text", text: "a " }, mathNode("x"), { type: "text", text: " b" }),
  ],
  [
    // Marks on the surrounding text survive; the formula node replaces its slice.
    paragraph({ type: "text", text: "see $x$", marks: [{ type: "bold" }] }),
    paragraph({ type: "text", text: "see ", marks: [{ type: "bold" }] }, mathNode("x")),
  ],
  [
    // Already-converted formula nodes pass through untouched.
    paragraph(mathNode("y"), { type: "text", text: " tail" }),
    paragraph(mathNode("y"), { type: "text", text: " tail" }),
  ],
];

let checked = 0;
for (const [input, expected] of inputRulePairs) {
  assert.deepEqual(
    findMathInputRule(input),
    expected,
    `findMathInputRule(${JSON.stringify(input)})`,
  );
  checked++;
}
for (const [input, expected] of pasteRulePairs) {
  assert.deepEqual(
    findMathPasteRule(input),
    expected,
    `findMathPasteRule(${JSON.stringify(input)})`,
  );
  checked++;
}
for (const [input, expected] of normalizePairs) {
  assert.deepEqual(normalizeMath(input), expected, `normalizeMath(${JSON.stringify(input)})`);
  checked++;
}
console.log(`mathsplit: ${checked} input/output pairs pass`);
