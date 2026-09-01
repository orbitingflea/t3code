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

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function escapeUnpairedInlineDollars(text: string): string {
  const candidates: Array<number> = [];
  const openers: Array<number> = [];
  const paired = new Set<number>();

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "$" || isEscaped(text, index)) continue;

    let runEnd = index + 1;
    while (text[runEnd] === "$") runEnd += 1;
    if (runEnd - index !== 1) {
      index = runEnd - 1;
      continue;
    }

    candidates.push(index);
    const previous = text[index - 1];
    const next = text[index + 1];
    const canOpen = next !== undefined && !/\s/.test(next);
    const canClose = previous !== undefined && !/\s/.test(previous) && !/\d/.test(next ?? "");

    if (canClose && openers.length > 0) {
      const opener = openers.pop();
      if (opener !== undefined) {
        paired.add(opener);
        paired.add(index);
      }
    } else if (canOpen) {
      openers.push(index);
    }
  }

  if (paired.size === candidates.length) return text;
  const unpaired = new Set(candidates.filter((index) => !paired.has(index)));
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    output += unpaired.has(index) ? `\\${text[index]}` : text[index];
  }
  return output;
}

function normalizeMathText(text: string): string {
  return escapeUnpairedInlineDollars(
    text
      .replace(/\\\((.+?)\\\)/g, (_, math: string) => `$${math}$`)
      .replace(/\$\$(.+?)\$\$/g, (_, math: string) => `\n\n$$\n${math}\n$$\n\n`)
      .replace(/^\s*\\\[\s*$/, "$$$$")
      .replace(/^\s*\\\]\s*$/, "$$$$"),
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
