import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  listedAncestor,
  opensAsChatTab,
  projectRelation,
  type ThreadPlace,
} from "./threadLink.logic";

const env = EnvironmentId.make("env-1");
const owner = scopeThreadRef(env, ThreadId.make("owner"));
const target = scopeThreadRef(env, ThreadId.make("target"));
const far = scopeThreadRef(EnvironmentId.make("env-2"), ThreadId.make("target"));
const place = (projectId: string, lineage: Partial<ThreadPlace["lineage"]> = {}): ThreadPlace => ({
  projectId: ProjectId.make(projectId),
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make("root"),
    ...lineage,
  },
});

describe("where a thread link in a chat goes", () => {
  it.each<[string, typeof target, ThreadPlace | null, ThreadPlace | null, boolean]>([
    ["a listed thread of the same project opens a Chat tab", target, place("p"), place("p"), true],
    ["a thread of another project navigates", target, place("p"), place("q"), false],
    ["a thread of another environment navigates", far, place("p"), place("p"), false],
    ["a thread no shell or detail places navigates", target, place("p"), null, false],
    ["a link in a chat no shell places navigates", target, null, place("p"), false],
    [
      "a side chat keeps upstream's route",
      target,
      place("p"),
      place("p", { sideChat: true, parentThreadId: owner.threadId }),
      false,
    ],
    [
      "a subagent keeps upstream's route",
      target,
      place("p"),
      place("p", { relationshipToParent: "subagent", parentThreadId: owner.threadId }),
      false,
    ],
  ])("%s", (_name, thread, ownerPlace, threadPlace, opens) => {
    expect(opensAsChatTab(owner, ownerPlace, thread, threadPlace)).toBe(opens);
  });
});

describe("whether a saved Chat tab's thread works in the owner's project", () => {
  it.each<[string, typeof target, ThreadPlace | null, "same" | "other" | null]>([
    ["the same project, from a shell or a loaded detail", target, place("p"), "same"],
    ["another project, from a shell or a loaded detail", target, place("q"), "other"],
    ["another environment", far, null, "other"],
    ["unknown while neither shell nor detail places it", target, null, null],
  ])("is %s", (_name, thread, threadPlace, relation) => {
    expect(projectRelation(owner, place("p"), thread, threadPlace)).toBe(relation);
  });
});

describe("the listed thread a side thread belongs to", () => {
  const id = ThreadId.make;
  const lineages: Record<string, ThreadPlace["lineage"]> = {
    owner: place("p").lineage,
    guest: place("p").lineage,
    side: place("p", { sideChat: true, parentThreadId: id("owner") }).lineage,
    agent: place("p", { relationshipToParent: "subagent", parentThreadId: id("side") }).lineage,
    loop: place("p", { relationshipToParent: "subagent", parentThreadId: id("loop") }).lineage,
  };
  const lineageOf = (thread: ThreadId) => lineages[thread] ?? null;

  it.each<[string, string | null, string | null, string?]>([
    ["the owner, for its own side chat", "owner", "owner"],
    ["the owner, for a subagent of its side chat", "side", "owner"],
    ["the owner, for a subagent of that subagent", "agent", "owner"],
    ["a hosted Chat, for its side thread", "guest", "guest"],
    ["the nearest unloaded thread, while its lineage is unknown", "unloaded", "unloaded"],
    ["the thread where a lineage loops", "loop", "loop"],
    ["none, for a thread with no parent", null, null],
    ["the page's own subagent, for that subagent's child", "agent", "agent", "agent"],
  ])("is %s", (_name, parent, ancestor, owner = "owner") => {
    expect(listedAncestor(parent === null ? null : id(parent), lineageOf, id(owner))).toBe(
      ancestor,
    );
  });
});
