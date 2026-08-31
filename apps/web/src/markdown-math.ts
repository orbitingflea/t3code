export function normalizeChatMath(markdown: string): string {
  const lines = markdown.split("\n");
  let fenced = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const bracketMath = /^\s*\\\[(.*)\\\]\s*$/.exec(line);
      if (bracketMath) return `$$\n${bracketMath[1] ?? ""}\n$$`;
      const dollarMath = /^\s*\$\$(.+)\$\$\s*$/.exec(line);
      if (dollarMath) return `$$\n${dollarMath[1] ?? ""}\n$$`;
      return line
        .split(/(`+[^`]*`+)/g)
        .map((part) =>
          part.startsWith("`")
            ? part
            : part
                .replace(/\\\[(.+?)\\\]/g, (_, math: string) => `\n\n$$\n${math}\n$$\n\n`)
                .replace(/\\\((.+?)\\\)/g, (_, math: string) => `$${math}$`)
                .replace(/\$\$(.+?)\$\$/g, (_, math: string) => `\n\n$$\n${math}\n$$\n\n`)
                .replace(/^\s*\\\[\s*$/, "$$$$")
                .replace(/^\s*\\\]\s*$/, "$$$$")
                .replace(
                  /(^|\s)\$(?=\d+(?:[.,]\d+)?(?:\s|[.,!?]|$))/g,
                  (_, prefix: string) => `${prefix}\\$`,
                ),
        )
        .join("");
    })
    .join("\n");
}
