import {
  errorText,
  isObject,
  readTextIfPresent,
  type RunnerPaths,
  userHookFile,
  writeFileAtomic,
} from "./shapes.ts";

const NodeFS = process.getBuiltinModule("node:fs");
const NodePath = process.getBuiltinModule("node:path");

const KEY_KINDS = ["git", "folder"] as const;

/** What a trust covers: every checkout of one repository, or one plain folder. */
export interface TrustKey {
  readonly kind: (typeof KEY_KINDS)[number];
  readonly path: string;
}

export interface Project {
  readonly folder: string;
  readonly hooksDir: string;
  readonly file: string;
  readonly key: TrustKey | null;
  readonly trusted: boolean;
}

const isFile = (path: string): boolean => {
  try {
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

const realPathOrNull = (path: string): string | null => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return null;
  }
};

const nearestHookFile = (cwd: string, paths: RunnerPaths): string | null => {
  let folder = NodePath.resolve(cwd);
  for (;;) {
    const file = NodePath.join(folder, ".agents", "hooks", "hooks.json");
    if (isFile(file)) {
      const real = realPathOrNull(file);
      return real === null || real === realPathOrNull(userHookFile(paths)) ? null : file;
    }
    const parent = NodePath.dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
};

// A `.git` file can name any folder, so it counts only when the repository lists that folder as one
// of its worktrees and the folder names this checkout back. Without both checks, an unpacked
// archive could take the key of a repository the user trusts.
const linkedWorktreeCommonDir = (folder: string, dotGit: string): string | null => {
  const named = /^gitdir: (.+)$/m.exec(NodeFS.readFileSync(dotGit, "utf8"))?.[1];
  if (named === undefined) return null;
  const gitDir = NodePath.resolve(folder, named.trim());
  const commonDir = readTextIfPresent(NodePath.join(gitDir, "commondir"));
  const checkout = readTextIfPresent(NodePath.join(gitDir, "gitdir"));
  if (commonDir === null || checkout === null) return null;
  if (
    NodeFS.realpathSync(NodePath.resolve(gitDir, checkout.trim())) !== NodeFS.realpathSync(dotGit)
  ) {
    return null;
  }
  const common = NodeFS.realpathSync(NodePath.resolve(gitDir, commonDir.trim()));
  return NodePath.dirname(NodeFS.realpathSync(gitDir)) === NodePath.join(common, "worktrees")
    ? common
    : null;
};

const trustKeyOf = (folder: string): TrustKey | null => {
  try {
    const dotGit = NodePath.join(folder, ".git");
    const entry = NodeFS.lstatSync(dotGit, { throwIfNoEntry: false });
    if (entry?.isDirectory()) return { kind: "git", path: NodeFS.realpathSync(dotGit) };
    const commonDir = entry?.isFile() ? linkedWorktreeCommonDir(folder, dotGit) : null;
    return commonDir === null
      ? { kind: "folder", path: NodeFS.realpathSync(folder) }
      : { kind: "git", path: commonDir };
  } catch {
    return null;
  }
};

const trustListPath = (paths: RunnerPaths): string =>
  NodePath.join(paths.stateDir, "trusted-projects.json");

/** The trusted keys. It throws when the file is there and is not a trust list. */
export const readTrustList = (paths: RunnerPaths): ReadonlyArray<TrustKey> => {
  const file = trustListPath(paths);
  try {
    const text = readTextIfPresent(file);
    if (text === null) return [];
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.projects)) {
      throw new Error('expected {"version": 1, "projects": [...]}');
    }
    return parsed.projects.flatMap((entry: unknown) => {
      if (!isObject(entry) || typeof entry.path !== "string") return [];
      const kind = KEY_KINDS.find((candidate) => candidate === entry.kind);
      return kind === undefined ? [] : [{ kind, path: entry.path }];
    });
  } catch (cause) {
    throw new Error(`${file}: ${errorText(cause)}`, { cause });
  }
};

const sameKey = (left: TrustKey, right: TrustKey): boolean =>
  left.kind === right.kind && left.path === right.path;

/** Adds the key to the trust list or removes it. False when the list already was that way. */
export const setTrusted = (key: TrustKey, trusted: boolean, paths: RunnerPaths): boolean => {
  const list = readTrustList(paths);
  if (list.some((entry) => sameKey(entry, key)) === trusted) return false;
  const projects = trusted ? [...list, key] : list.filter((entry) => !sameKey(entry, key));
  writeFileAtomic(trustListPath(paths), `${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
  return true;
};

/** The project of a working folder: the nearest folder at or above it with its own hook file. */
export const findProject = (cwd: string, paths: RunnerPaths): Project | null => {
  const file = nearestHookFile(cwd, paths);
  if (file === null) return null;
  const hooksDir = NodePath.dirname(file);
  const folder = NodePath.dirname(NodePath.dirname(hooksDir));
  const key = trustKeyOf(folder);
  let trusted = false;
  try {
    trusted = key !== null && readTrustList(paths).some((entry) => sameKey(entry, key));
  } catch {
    trusted = false;
  }
  return { folder, hooksDir, file, key, trusted };
};

export const describeKey = (key: TrustKey): string =>
  key.kind === "git"
    ? `the git repository ${key.path} and its worktrees`
    : `the folder ${key.path}`;
