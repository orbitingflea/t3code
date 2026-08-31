interface Fence {
  marker: "`" | "~";
  length: number;
}

function stripBlockquotePrefix(line: string): string {
  return line.replace(/^ {0,3}(?:> ?)+/, "");
}

function readFence(line: string): Fence | null {
  const match = /^\s{0,3}(`{3,}|~{3,})/.exec(stripBlockquotePrefix(line));
  const delimiter = match?.[1];
  if (!delimiter) return null;
  return {
    marker: delimiter[0] as Fence["marker"],
    length: delimiter.length,
  };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^\s{0,3}(`+|~+)\s*$/.exec(stripBlockquotePrefix(line));
  const delimiter = match?.[1];
  return (
    delimiter !== undefined && delimiter[0] === fence.marker && delimiter.length >= fence.length
  );
}

function findHtmlTagEnd(text: string, start: number): number {
  if (!/[A-Za-z/!]/.test(text[start + 1] ?? "")) return -1;

  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index + 1;
  }
  return -1;
}

function findLinkDestinationEnd(text: string, start: number): number {
  let depth = 1;
  for (let index = start + 2; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") depth += 1;
    if (character !== ")") continue;
    depth -= 1;
    if (depth === 0) return index + 1;
  }
  return -1;
}

function normalizeMathText(text: string): string {
  return text
    .replace(/\\\((.+?)\\\)/g, (_, math: string) => `$${math}$`)
    .replace(/\$\$(.+?)\$\$/g, (_, math: string) => `\n\n$$\n${math}\n$$\n\n`)
    .replace(/^\s*\\\[\s*$/, "$$$$")
    .replace(/^\s*\\\]\s*$/, "$$$$")
    .replace(
      /(^|[\s([{:;,-])\$(?=\d+(?:[.,]\d+)?(?:\s|[.,!?/%:;)\]}-]|$))/g,
      (_, prefix: string) => `${prefix}\\$`,
    );
}

function normalizeOutsideMarkdownDestinations(text: string): string {
  let output = "";
  let plainStart = 0;
  let index = 0;

  while (index < text.length) {
    let protectedEnd = -1;
    if (text[index] === "<") {
      protectedEnd = findHtmlTagEnd(text, index);
    } else if (text[index] === "]" && text[index + 1] === "(") {
      protectedEnd = findLinkDestinationEnd(text, index);
    }

    if (protectedEnd === -1) {
      index += 1;
      continue;
    }

    output += normalizeMathText(text.slice(plainStart, index));
    output += text.slice(index, protectedEnd);
    index = protectedEnd;
    plainStart = protectedEnd;
  }

  return output + normalizeMathText(text.slice(plainStart));
}

function findClosingBacktickRun(text: string, start: number, length: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] !== "`") continue;
    let end = index + 1;
    while (text[end] === "`") end += 1;
    if (end - index === length) return index;
    index = end - 1;
  }
  return -1;
}

function normalizeOutsideInlineCode(line: string): string {
  let output = "";
  let plainStart = 0;
  let index = 0;

  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }

    let openingEnd = index + 1;
    while (line[openingEnd] === "`") openingEnd += 1;
    const closingStart = findClosingBacktickRun(line, openingEnd, openingEnd - index);
    if (closingStart === -1) {
      index = openingEnd;
      continue;
    }

    const closingEnd = closingStart + openingEnd - index;
    output += normalizeOutsideMarkdownDestinations(line.slice(plainStart, index));
    output += line.slice(index, closingEnd);
    index = closingEnd;
    plainStart = closingEnd;
  }

  return output + normalizeOutsideMarkdownDestinations(line.slice(plainStart));
}

export function normalizeChatMath(markdown: string): string {
  const lines = markdown.split("\n");
  let fence: Fence | null = null;

  return lines
    .map((line) => {
      if (fence !== null) {
        if (closesFence(line, fence)) fence = null;
        return line;
      }

      const openingFence = readFence(line);
      if (openingFence !== null) {
        fence = openingFence;
        return line;
      }

      const content = stripBlockquotePrefix(line);
      if (/^(?: {4}|\t)/.test(content)) return line;

      const bracketMath = /^\s*\\\[(.*)\\\]\s*$/.exec(content);
      if (bracketMath) return `$$\n${bracketMath[1] ?? ""}\n$$`;
      const dollarMath = [...content.matchAll(/\$\$(.+?)\$\$/g)];
      if (dollarMath.length === 1 && content.trim() === dollarMath[0]?.[0]) {
        return `$$\n${dollarMath[0]?.[1] ?? ""}\n$$`;
      }
      return normalizeOutsideInlineCode(line);
    })
    .join("\n");
}
