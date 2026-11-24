import type { FileLinkPathDepth } from "@t3tools/contracts";
import { isWindowsAbsolutePath, stripSlashPrefixedWindowsDrive } from "@t3tools/shared/path";

import type { MarkdownFileLinkMeta } from "../markdown-links";

export type FileLinkPathMeta = Pick<
  MarkdownFileLinkMeta,
  "filePath" | "workspaceRelativePath" | "workspaceLookupPath"
>;

export interface FileLinkPathView {
  readonly depth: FileLinkPathDepth;
  readonly home: string | null;
  // The server runs on Windows, where Git Bash writes `C:\x` as `/c/x`.
  readonly windows: boolean;
  // File names that repeat in the message, from `repeatedFileNames`.
  readonly repeatedNames: ReadonlySet<string>;
}

/** The file names of a message's repeated-name folder hints. */
export function repeatedFileNames(parentSuffixByPath: ReadonlyMap<string, string>): Set<string> {
  return new Set([...parentSuffixByPath.keys()].map(lastName));
}

type PathKind = "posix" | "relative" | "drive" | "unc";

interface FoldedPath {
  readonly kind: PathKind;
  // `.` dropped and `..` folded; a drive path starts with its drive (`C:`), a UNC path with its server.
  readonly names: readonly string[];
  // The walk shows no folder before this index.
  readonly floor: number;
}

function foldPath(raw: string): FoldedPath {
  const kind: PathKind = raw.startsWith("\\\\")
    ? "unc"
    : isWindowsAbsolutePath(raw)
      ? "drive"
      : raw.startsWith("/")
        ? "posix"
        : "relative";
  const windows = kind === "drive" || kind === "unc";
  // `..` never climbs above a drive or a UNC share.
  const top = kind === "drive" ? 1 : kind === "unc" ? 2 : 0;
  const names: string[] = [];
  for (const part of raw.split(windows ? /[\\/]/ : "/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") names.push(part);
    else if (names.length > top && names.at(-1) !== "..") names.pop();
    else if (kind === "relative") names.push(part);
  }
  // A UNC path shows its server and share like folders, as before; it draws no root marker.
  const floor = kind === "relative" ? names.lastIndexOf("..") + 1 : 0;
  return { kind, names, floor };
}

// How many leading names of `path` are the home folder; undefined when it is not under home.
function homeLength(path: FoldedPath, home: string | null): number | undefined {
  if (path.kind === "relative") return path.floor === 0 && path.names[0] === "~" ? 1 : undefined;
  if (home === null) return undefined;
  const homePath = foldPath(home);
  // A home at `/` or at a drive root is that root, which draws its own marker.
  if (homePath.names.length <= (homePath.kind === "drive" ? 1 : 0)) return undefined;
  if (homePath.kind !== path.kind || homePath.names.length > path.names.length) return undefined;
  const same =
    path.kind === "posix"
      ? (a: string, b: string) => a === b
      : (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return homePath.names.every((name, i) => same(name, path.names[i]!))
    ? homePath.names.length
    : undefined;
}

/**
 * Returns the path prefix before a file link's name, with up to `depth - 1` folders, ending in `/`.
 * Stops early at home with `~/`, at POSIX root with `/`, or at a Windows drive root such as `C:/`.
 * Returns `undefined` at depth 1, for a repeated file name, or when there is nothing to show.
 */
export function fileLinkPathPrefix(
  meta: FileLinkPathMeta,
  view: FileLinkPathView,
): string | undefined {
  if (view.depth === 1) return undefined;
  // A repeated file name keeps its folder hint after the name instead. The hint map leaves out a
  // copy that has no folder above it, so the check goes by name.
  const name = lastName(meta.filePath);
  if (view.repeatedNames.has(name)) return undefined;
  // The label of a link ending in `.`, `..` or a bare `~` is that name, not the folder it
  // reaches, so any folders drawn before it would name another path.
  if (name === "." || name === ".." || /^~[\\/]*$/.test(meta.filePath)) return undefined;
  const path = foldPath(hostPath(meta, view));
  // The label names such a file by its last `\` part, so folders before it would misname the path.
  if ((path.kind === "posix" || path.kind === "relative") && path.names.at(-1)?.includes("\\")) {
    return undefined;
  }
  const folders = path.names.length - 1;
  const home = homeLength(path, view.home);
  // A link written relative to the workspace may open a search match in another folder, so only
  // the folders it names are sure, and no marker is drawn above them.
  const lookup = meta.workspaceLookupPath;
  const written =
    lookup !== null && !/^(?:\.{1,2}|~)[\\/]/.test(lookup) && !/[\\/]$/.test(lookup)
      ? foldPath(lookup)
      : null;
  // Names before any leading `..` the link keeps are not folders it names.
  const unsure = written === null ? -1 : path.names.length - (written.names.length - written.floor);
  // `above` counts the folders still hidden; the walk moves up one folder at a time.
  let above = folders;
  let marker = "";
  while (above > unsure) {
    if (above === home) marker = "~/";
    else if (path.kind === "posix" && above === 0) marker = "/";
    else if (path.kind === "drive" && above === 1) marker = `${path.names[0]}/`;
    if (marker !== "" || above <= path.floor || folders - above === view.depth - 1) break;
    above -= 1;
  }
  const shown = path.names.slice(Math.max(above, unsure), folders);
  const prefix = marker + shown.map((folder) => `${folder}/`).join("");
  return prefix === "" ? undefined : prefix;
}

function lastName(path: string): string {
  return (
    path
      .split(/[\\/]/)
      .filter((part) => part !== "")
      .at(-1) ?? ""
  );
}

// The file's path as the server reads it, as far as display needs it.
function hostPath(meta: FileLinkPathMeta, { home, windows }: FileLinkPathView): string {
  // An unexpanded `~/` link names the reported home.
  if (/^~[\\/]/.test(meta.filePath) && home) {
    return `${home.replace(/[\\/]+$/, "")}/${meta.filePath.slice(2)}`;
  }
  // Only a path outside the workspace may be a Windows drive written after a slash; inside a
  // workspace at `/`, `/C:/a.md` names a POSIX folder `C:`.
  if (meta.workspaceRelativePath !== null) return meta.filePath;
  // A Windows server reads Git Bash's `/c/x` as `C:/x`.
  if (windows) {
    const drive = /^\/([a-zA-Z])(?=\/|$)/.exec(meta.filePath);
    if (drive !== null) return `${drive[1]!.toUpperCase()}:${meta.filePath.slice(2) || "/"}`;
  }
  return stripSlashPrefixedWindowsDrive(meta.filePath);
}
