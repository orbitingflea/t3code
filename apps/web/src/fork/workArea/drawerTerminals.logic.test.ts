import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import { adoptedTerminals, reusableTabTerminal } from "./drawerTerminals.logic";

const terminalTab = (...ids: string[]): RightPanelSurface => ({
  id: `terminal:${ids[0]}`,
  kind: "terminal",
  resourceId: ids[0]!,
  terminalIds: ids,
  activeTerminalId: ids[0]!,
});

describe("reusableTabTerminal", () => {
  const tabs = [terminalTab("t1", "t2"), terminalTab("t3")];
  it.each<[string, string | null, string[], string[], string | null]>([
    ["the shown tab's terminal first", "t3", [], [], "t3"],
    ["else the first idle tab terminal", null, [], [], "t1"],
    ["never a running one", "t3", ["t3", "t1"], [], "t2"],
    ["never a closing one", "t3", [], ["t3"], "t1"],
    ["none when all are busy", null, ["t1", "t2"], ["t3"], null],
  ])("%s", (_, shown, running, closing, expected) => {
    expect(reusableTabTerminal(tabs, shown, running, closing)).toBe(expected);
  });
});

describe("adoptedTerminals", () => {
  const run = (
    sessionIds: string[],
    tabIds: string[],
    seen: Iterable<string> = [],
    skipped: string[] = [],
  ) => adoptedTerminals({ sessionIds, tabIds, seen: new Set(seen), skipped });

  it("adopts listed sessions with no tab, in server order", () => {
    const { adopt, seen } = run(["setup", "t1", "t2"], ["t1"]);
    expect(adopt).toEqual(["setup", "t2"]);
    expect([...seen].toSorted()).toEqual(["setup", "t1", "t2"]);
  });

  it("skips closing and suppressed ids", () => {
    expect(run(["t1", "t2", "t3"], [], [], ["t1", "t3"]).adopt).toEqual(["t2"]);
  });

  it("keeps a closed tab closed while the server still lists its session", () => {
    const shown = run(["t2"], ["t2"]);
    // A failed close: the session stays listed and upstream suppresses its id.
    expect(run(["t2"], [], shown.seen, ["t2"]).adopt).toEqual([]);
    // A read-only close: no session close, no suppression.
    expect(run(["t2"], [], shown.seen).adopt).toEqual([]);
  });

  it("adopts a session again once the server stopped listing it in between", () => {
    const shown = run(["t2"], ["t2"]);
    const gone = run([], [], shown.seen);
    expect(gone.seen.size).toBe(0);
    expect(run(["t2"], [], gone.seen).adopt).toEqual(["t2"]);
  });
});
