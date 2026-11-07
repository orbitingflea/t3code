import { describe, expect, it } from "vite-plus/test";

import { unreadCharacters } from "./dashboardDiff";

/** Each current block with its unread runs in brackets. */
function marked(read: ReadonlyArray<string>, current: ReadonlyArray<string>): string[] {
  const flags = unreadCharacters(read, current);
  return current.map((block, index) =>
    block
      .split("")
      .map((character, ci) => {
        const unread = flags[index]![ci]!;
        const opens = unread && !flags[index]![ci - 1];
        const closes = unread && !flags[index]![ci + 1];
        return `${opens ? "[" : ""}${character}${closes ? "]" : ""}`;
      })
      .join(""),
  );
}

describe("unreadCharacters", () => {
  it("marks nothing when the text is what the user read", () => {
    expect(marked(["Waiting on CI", "PR 12"], ["Waiting on CI", "PR 12"])).toEqual([
      "Waiting on CI",
      "PR 12",
    ]);
  });

  it("marks everything when the user has read nothing", () => {
    expect(marked([], ["Pick A or B", "Then merge"])).toEqual(["[Pick A or B]", "[Then merge]"]);
  });

  it("marks only the new characters of a slightly edited line", () => {
    expect(
      marked(["Waiting on the CI run for PR 12"], ["Waiting on the CI run for PR 123"]),
    ).toEqual(["Waiting on the CI run for PR 12[3]"]);
  });

  it("joins two changes split by one unchanged character", () => {
    expect(marked(["abcdefghijkl"], ["aXcYefghijkl"])).toEqual(["a[XcY]efghijkl"]);
  });

  it("marks a whole line changed in 3 or more places", () => {
    expect(marked(["aaaa bbbb cccc dddd"], ["aXaa bbXb ccXc dddd"])).toEqual([
      "[aXaa bbXb ccXc dddd]",
    ]);
  });

  it("marks a whole line that is under 60% the same", () => {
    expect(marked(["Review PR 12"], ["Review PR 12 and PR 13 now"])).toEqual([
      "[Review PR 12 and PR 13 now]",
    ]);
  });

  it("marks an inserted line and leaves the lines around it read", () => {
    expect(marked(["First", "Last"], ["First", "Inserted", "Last"])).toEqual([
      "First",
      "[Inserted]",
      "Last",
    ]);
  });

  it("marks nothing for a deleted line", () => {
    expect(marked(["First", "Gone", "Last"], ["First", "Last"])).toEqual(["First", "Last"]);
  });
});
