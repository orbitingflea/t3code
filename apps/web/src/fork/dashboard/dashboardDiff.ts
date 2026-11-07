/** For each item of `a`, the index of its match in `b` in one longest common subsequence, else -1. */
function lcs(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
  const map: number[] = Array.from({ length: n }, () => -1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      map[i] = j;
      i++;
      j++;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) i++;
    else j++;
  }
  return map;
}

// Pairing a line costs its length times the other's; longer pairs count as rewritten lines.
const MAX_CHARACTER_PAIRS = 1_000_000;

/**
 * Marks each `current` block's unread characters as follows: a block pairs with the most
 * alike read block in its gap (40% or more) and marks only its changed characters, unless it is
 * under 60% the same or changed in 3 or more places, then all of it. Unpaired blocks are all unread.
 */
export function unreadCharacters(
  read: ReadonlyArray<string>,
  current: ReadonlyArray<string>,
): boolean[][] {
  const map = lcs(current, read);
  const out: boolean[][] = Array.from({ length: current.length }, () => []);
  let i = 0;
  let readStart = 0;
  while (i <= current.length) {
    let j = i;
    while (j < current.length && map[j]! < 0) j++;
    const readEnd = j < current.length ? map[j]! : read.length;
    const pairs: Array<{ k: number; o: number; same: number; cmap: number[] }> = [];
    for (let k = i; k < j; k++)
      for (let o = readStart; o < readEnd; o++) {
        const line = current[k]!;
        const old = read[o]!;
        if (line.length * old.length > MAX_CHARACTER_PAIRS) continue;
        const cmap = lcs(line.split(""), old.split(""));
        const same = cmap.filter((x) => x >= 0).length;
        if (same >= 0.4 * Math.max(line.length, old.length)) pairs.push({ k, o, same, cmap });
      }
    pairs.sort((a, b) => b.same - a.same);
    const usedK = new Set<number>();
    const usedO = new Set<number>();
    for (const pair of pairs) {
      if (usedK.has(pair.k) || usedO.has(pair.o)) continue;
      usedK.add(pair.k);
      usedO.add(pair.o);
      const length = current[pair.k]!.length;
      const changed = pair.cmap.map((x) => x < 0);
      for (let ci = 1; ci < length - 1; ci++)
        if (!changed[ci] && changed[ci - 1] && changed[ci + 1]) changed[ci] = true;
      const pieces = changed.filter((c, ci) => c && !changed[ci - 1]).length;
      out[pair.k] = pair.same < 0.6 * length || pieces >= 3 ? changed.map(() => true) : changed;
    }
    for (let k = i; k < j; k++)
      if (!usedK.has(k)) out[k] = Array.from({ length: current[k]!.length }, () => true);
    if (j < current.length) {
      out[j] = Array.from({ length: current[j]!.length }, () => false);
      readStart = map[j]! + 1;
    }
    i = j + 1;
  }
  return out;
}
