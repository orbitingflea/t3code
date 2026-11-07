import { describe, expect, it } from "vite-plus/test";

import { extractTerminalLinks, type TerminalLinkKind } from "../terminal-links";

function linksIn(line: string, ...links: ReadonlyArray<readonly [TerminalLinkKind, string]>) {
  let from = 0;
  return links.map(([kind, text]) => {
    const start = line.indexOf(text, from);
    from = start + text.length;
    return { kind, text, start, end: from };
  });
}

describe("extractTerminalLinks with CJK punctuation", () => {
  it.each([
    ["（https://example.com/pull/78），Claude 和", [["url", "https://example.com/pull/78"]]],
    ["改了（/home/me/a.ts），然后", [["path", "/home/me/a.ts"]]],
    ["见 https://example.com/a），好", [["url", "https://example.com/a"]]],
    ["报错在 ./src/a.ts:12：类型不对", [["path", "./src/a.ts:12"]]],
    [
      "改了 /repo/a.ts、/repo/b.ts。",
      [
        ["path", "/repo/a.ts"],
        ["path", "/repo/b.ts"],
      ],
    ],
    [
      "「~/notes/a.md」和【https://example.com/b】",
      [
        ["path", "~/notes/a.md"],
        ["url", "https://example.com/b"],
      ],
    ],
    ["见 https://example.com/pull/78（已合并）。", [["url", "https://example.com/pull/78"]]],
    ["改了 /home/me/a.ts（已提交）", [["path", "/home/me/a.ts"]]],
    ["./docs/报告（最终版.md 没写完", [["path", "./docs/报告"]]],
    [
      "见 /home/me/报告（https://example.com/b）",
      [
        ["path", "/home/me/报告"],
        ["url", "https://example.com/b"],
      ],
    ],
    ["报错在 ./docs/报告（最终版）.md:12：类型不对", [["path", "./docs/报告（最终版）.md:12"]]],
    ["见（./docs/报告（最终版）.md），然后", [["path", "./docs/报告（最终版）.md"]]],
  ] as const)("ends links at CJK punctuation in %j", (line, links) => {
    expect(extractTerminalLinks(line)).toEqual(linksIn(line, ...links));
  });

  it.each([
    ["see /home/me/目录/a.ts for details", [["path", "/home/me/目录/a.ts"]]],
    ["(see /home/me/a.ts), then", [["path", "/home/me/a.ts"]]],
    [`open "/home/me/文件（1）.txt" now`, [["path", "/home/me/文件（1）.txt"]]],
    ["./docs/报告（最终版）.md:12", [["path", "./docs/报告（最终版）.md:12"]]],
    ["见 ./docs/报告（第一版（草稿））.md 吧", [["path", "./docs/报告（第一版（草稿））.md"]]],
    ["见 /home/me/书/《三体》.pdf 吧", [["path", "/home/me/书/《三体》.pdf"]]],
    ["见 /home/me/report（1）.pdf 吧", [["path", "/home/me/report（1）.pdf"]]],
    [
      "见 https://example.com/wiki/苹果（消歧义）",
      [["url", "https://example.com/wiki/苹果（消歧义）"]],
    ],
  ] as const)("keeps links that need no CJK ending in %j", (line, links) => {
    expect(extractTerminalLinks(line)).toEqual(linksIn(line, ...links));
  });

  it.each(["〜", "－", "＿", "＃", "＆", "･"])("keeps the connector %s inside a name", (mark) => {
    const path = `/home/me/第1章${mark}第3章.md`;
    const line = `见 ${path} 吧`;
    expect(extractTerminalLinks(line)).toEqual(linksIn(line, ["path", path]));
  });
});
