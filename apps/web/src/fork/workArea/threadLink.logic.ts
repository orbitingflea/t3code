import {
  isListedThreadLineage,
  type OrchestrationV2AppThreadLineage,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

export interface ThreadPlace {
  readonly projectId: ProjectId;
  readonly lineage: OrchestrationV2AppThreadLineage;
}

/**
 * Only listed threads in the owner's environment and project open as Chat tabs; side threads
 * keep upstream's route and all others navigate.
 */
export const opensAsChatTab = (
  owner: ScopedThreadRef,
  ownerPlace: ThreadPlace | null,
  target: ScopedThreadRef,
  targetPlace: ThreadPlace | null,
): boolean =>
  targetPlace !== null &&
  projectRelation(owner, ownerPlace, target, targetPlace) === "same" &&
  isListedThreadLineage(targetPlace.lineage);

export function projectRelation(
  owner: ScopedThreadRef,
  ownerPlace: ThreadPlace | null,
  target: ScopedThreadRef,
  targetPlace: ThreadPlace | null,
): "same" | "other" | null {
  if (owner.environmentId !== target.environmentId) return "other";
  if (ownerPlace === null || targetPlace === null) return null;
  return ownerPlace.projectId === targetPlace.projectId ? "same" : "other";
}

export function listedAncestor(
  parent: ThreadId | null,
  lineageOf: (thread: ThreadId) => OrchestrationV2AppThreadLineage | null,
  owner: ThreadId,
): ThreadId | null {
  const seen = new Set<ThreadId>();
  let thread = parent;
  while (thread !== null && !seen.has(thread)) {
    // A subagent's own page owns its children, though the subagent is not listed.
    if (thread === owner) return thread;
    seen.add(thread);
    const lineage = lineageOf(thread);
    if (lineage === null || isListedThreadLineage(lineage) || lineage.parentThreadId === null) {
      return thread;
    }
    thread = lineage.parentThreadId;
  }
  return thread;
}
