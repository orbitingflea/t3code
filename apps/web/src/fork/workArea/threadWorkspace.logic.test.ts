import { describe, expect, it } from "vite-plus/test";

import { type ThreadWorkspace, threadWorkspace } from "./threadWorkspace.logic";

const project = { workspaceRoot: "/project" };
type Place = Parameters<typeof threadWorkspace>[0];

describe("threadWorkspace", () => {
  it.each<[string, Place, typeof project | null, string | null, ThreadWorkspace<typeof project>]>([
    [
      "reads a worktree",
      { worktreePath: "/wt" },
      project,
      null,
      { kind: "ready", project, cwd: "/wt" },
    ],
    [
      "reads the project root without a worktree",
      { worktreePath: null },
      project,
      null,
      { kind: "ready", project, cwd: "/project" },
    ],
    ["loads while the thread's place is unknown", null, null, null, { kind: "loading" }],
    ["loads while the project is unknown", { worktreePath: null }, null, null, { kind: "loading" }],
    [
      "fails when the thread's detail fails",
      null,
      null,
      "Thread not found",
      { kind: "error", message: "Thread not found" },
    ],
  ])("%s", (_name, place, found, error, expected) => {
    expect(threadWorkspace(place, found, error)).toEqual(expected);
  });
});
