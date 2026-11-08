import { expect, it } from "vite-plus/test";
import { searchableMessageSegments, searchablePlanSegments } from "../threadFindText.ts";

it("indexes single tildes in a sent message as written and drops double-tilde markers", () => {
  expect(
    searchableMessageSegments({
      role: "user",
      text: "1~2 and 3~4, ~~gone~~",
      streaming: false,
    }),
  ).toEqual(["1~2 and 3~4, gone"]);
});

it("indexes single tildes in a plan as written and drops double-tilde markers", () => {
  expect(searchablePlanSegments("# Plan\n\n1~2 and 3~4, ~~gone~~")).toEqual([
    "Plan",
    "1~2 and 3~4, gone",
  ]);
});
