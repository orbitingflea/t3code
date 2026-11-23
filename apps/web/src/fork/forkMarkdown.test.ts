import type { Element, Root } from "hast";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast, type WordsHastOptions } from "../markdown/wordsHast";

const CHAT: WordsHastOptions = {
  math: true,
  breaks: false,
  escapeHtml: false,
  insights: false,
  extensions: {},
};

function elements(node: Root | Element, tagName: string): Element[] {
  return node.children.flatMap((child) =>
    child.type !== "element"
      ? []
      : [...(child.tagName === tagName ? [child] : []), ...elements(child, tagName)],
  );
}

const glyphs = (svg: Element) =>
  elements(svg, "text")
    .flatMap((text) => text.children.map((child) => (child.type === "text" ? child.value : "")))
    .join("");

describe("forkSource", () => {
  it("draws \\eps in math as \\varepsilon and copies it as written", () => {
    const tree = wordsHast("$\\eps_1$ and `\\eps`", CHAT);
    const [svg] = elements(tree, "svg");
    const [varepsilon] = elements(wordsHast("$\\varepsilon_1$", CHAT), "svg");
    expect(glyphs(svg!)).toBe(glyphs(varepsilon!));
    expect(svg!.properties.ariaLabel).toBe("\\eps_1");
    const [wrapper] = elements(tree, "span").filter(
      (span) => span.properties.dataMarkdownMath !== undefined,
    );
    expect(wrapper!.properties.dataMarkdownCopy).toBe("\\(\\eps_1\\)");
    expect(elements(tree, "code")[0]!.children).toEqual([
      expect.objectContaining({ type: "text", value: "\\eps" }),
    ]);
  });

  it.each([
    ["a quote", "> $$\n> \\eps +\n> \\eps\n> $$"],
    ["a list item", "- $$\n  \\eps +\n  \\eps\n  $$"],
  ])("copies multiline math inside %s as written", (_, text) => {
    const formula = (tree: Root) => {
      const [wrapper] = [...elements(tree, "div"), ...elements(tree, "span")].filter(
        (node) => node.properties.dataMarkdownMath !== undefined,
      );
      const [svg] = elements(wrapper!, "svg");
      return { copy: wrapper!.properties.dataMarkdownCopy, label: svg!.properties.ariaLabel, svg };
    };
    const swapped = formula(wordsHast(text, CHAT));
    const drawn = formula(wordsHast(text.replaceAll("\\eps", "\\varepsilon"), CHAT));
    const asWritten = (value: unknown) => String(value).replaceAll("\\varepsilon", "\\eps");
    expect(glyphs(swapped.svg!)).toBe(glyphs(drawn.svg!));
    expect(swapped.label).toBe(asWritten(drawn.label));
    expect(swapped.copy).toBe(asWritten(drawn.copy));
    expect(swapped.copy).toContain("\\eps +\n\\eps");
  });

  it("keeps a written {ε } beside a swapped \\eps, in the formula or its fence's info string", () => {
    const [svg] = elements(wordsHast("$\\eps {ε }$", CHAT), "svg");
    expect(svg!.properties.ariaLabel).toBe("\\eps {ε }");
    const [fenced] = elements(wordsHast("```math {ε } note\n\\eps + 1\n```", CHAT), "svg");
    expect(fenced!.properties.ariaLabel).toBe("\\eps + 1\n");
  });

  it("leaves \\epsilon, an escaped \\eps and math that is off as written", () => {
    const [epsilon] = elements(wordsHast("$\\epsilon$", CHAT), "svg");
    expect(epsilon!.properties.ariaLabel).toBe("\\epsilon");
    expect(glyphs(elements(wordsHast("$a\\\\eps$", CHAT), "svg")[0]!)).not.toContain("𝜀");
    expect(elements(wordsHast("$\\eps$", { ...CHAT, math: false }), "svg")).toEqual([]);
  });

  it("keeps offsets after a swapped formula", () => {
    const text = "$\\eps$\n\n- [ ] task";
    const [item] = elements(wordsHast(text, CHAT), "li");
    expect(item!.position?.start.offset).toBe(text.indexOf("- [ ]"));
  });
});

describe("forkHast inline", () => {
  it("renders a sole paragraph as its content, but not in a preview", () => {
    const inline = wordsHast("[](</a.md>)", { ...CHAT, inline: true });
    expect(inline.children.map((child) => child.type === "element" && child.tagName)).toEqual([
      "a",
    ]);
    const preview = wordsHast("text", {
      ...CHAT,
      inline: true,
      extensions: { preview: { fallback: "", maxLength: 100 } },
    });
    expect(elements(preview, "p")).toEqual([]);
  });
});
