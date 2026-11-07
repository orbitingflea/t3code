/** How alike, by `textSimilarity`, an edit's old text must be to the current text. */
export const TEXT_MATCH_MIN_RATIO = 0.7;

/** The text a reader sees: no HTML tags, links as their labels, whitespace runs as one space. */
export function visibleText(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function lcsLength(a: Uint32Array, b: Uint32Array): number {
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (const codePoint of a) {
    for (let j = 1; j <= b.length; j++) {
      current[j] =
        codePoint === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

// NFKC folds full-width and compatibility forms, so "ＡＢＣ" scores as "abc".
const comparable = (text: string) =>
  Uint32Array.from(visibleText(text.normalize("NFKC").toLowerCase()), (character) =>
    character.codePointAt(0)!,
  );

/**
 * 2 × LCS / (|a| + |b|) over the code points of the visible texts, after NFKC and lower case;
 * 1 when both are empty.
 */
export function textSimilarity(a: string, b: string): number {
  const left = comparable(a);
  const right = comparable(b);
  const total = left.length + right.length;
  if (total === 0) return 1;
  return (2 * lcsLength(left, right)) / total;
}
