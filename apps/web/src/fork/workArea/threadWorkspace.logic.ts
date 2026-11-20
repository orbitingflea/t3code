/** Where a thread's files are read, or why they cannot be read yet. */
export type ThreadWorkspace<P> =
  | { readonly kind: "ready"; readonly project: P; readonly cwd: string }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string };

/**
 * A thread's workspace from where it works (its shell, or its detail when the shell leaves it
 * out) and that place's project. It is loading until both are known, unless the detail failed.
 */
export function threadWorkspace<P extends { readonly workspaceRoot: string }>(
  place: { readonly worktreePath: string | null } | null,
  project: P | null,
  error: string | null,
): ThreadWorkspace<P> {
  if (place !== null && project !== null) {
    return { kind: "ready", project, cwd: place.worktreePath ?? project.workspaceRoot };
  }
  return place === null && error !== null ? { kind: "error", message: error } : { kind: "loading" };
}
