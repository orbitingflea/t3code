import type { FileLinkPathDepth } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type FileLinkPathMeta, fileLinkPathPrefix, repeatedFileNames } from "./fileLinkPathDepth";

const HOME = "/home/me";
const inWorkspace = (
  workspaceRelativePath: string,
  root = "/home/me/project",
): FileLinkPathMeta => ({
  filePath: `${root}/${workspaceRelativePath}`,
  workspaceRelativePath,
  workspaceLookupPath: null,
});
// A link written relative to the workspace, which may open a search match elsewhere.
const written = (workspaceRelativePath: string, root = "/home/me/project"): FileLinkPathMeta => ({
  ...inWorkspace(workspaceRelativePath, root),
  workspaceLookupPath: workspaceRelativePath,
});
const outside = (filePath: string): FileLinkPathMeta => ({
  filePath,
  workspaceRelativePath: null,
  workspaceLookupPath: null,
});
const collisions = new Map([
  ["/home/me/project/src/web/index.ts", "src/web"],
  ["C:/repo/src/server/index.ts", "src/server"],
]);

describe("fileLinkPathPrefix", () => {
  it.each<
    [string, FileLinkPathMeta, FileLinkPathDepth, string | null, string | undefined, boolean?]
  >([
    // Home and root examples at the default depth.
    ["a file in home", outside("/home/me/a.md"), 2, HOME, "~/"],
    ["a folder in home", outside("/home/me/dir/a.md"), 2, HOME, "~/dir/"],
    ["a file at root", outside("/a.md"), 2, HOME, "/"],
    ["a folder at root", outside("/etc/a.conf"), 2, HOME, "/etc/"],
    ["past home", outside("/home/me/x/dir/a.md"), 2, HOME, "dir/"],
    ["reaching home after two folders", outside("/home/me/x/dir/a.md"), 3, HOME, "~/x/dir/"],
    ["past root", outside("/etc/x/a.conf"), 2, HOME, "x/"],
    ["fewer folders than the depth at home", outside("/home/me/a.md"), 5, HOME, "~/"],
    ["fewer folders than the depth at root", outside("/etc/nginx/a.conf"), 5, HOME, "/etc/nginx/"],
    ["depth 1 shows no folder", outside("/home/me/dir/a.md"), 1, HOME, undefined],
    ["depth 1 shows no root", outside("/a.md"), 1, HOME, undefined],
    ["another user's home", outside("/home/bob/a.md"), 2, HOME, "bob/"],
    ["another user's home reaching root", outside("/home/bob/a.md"), 3, HOME, "/home/bob/"],
    ["a folder that only starts like home", outside("/home/me2/a.md"), 2, HOME, "me2/"],
    ["the folder above home", outside("/home/a.md"), 2, HOME, "/home/"],
    ["home unknown", outside("/home/me/a.md"), 2, null, "me/"],
    ["home at /root", outside("/root/notes/a.md"), 2, "/root", "~/notes/"],
    ["a home at root", outside("/etc/hosts"), 2, "/", "/etc/"],
    ["a home at a drive root", outside("C:\\x\\a.md"), 2, "C:\\", "C:/x/"],
    ["home given with a trailing slash", outside("/home/me/dir/a.md"), 2, "/home/me/", "~/dir/"],
    // An unexpanded `~/` link.
    ["a literal ~ file", outside("~/a.md"), 2, null, "~/"],
    ["a literal ~ folder", outside("~/notes/a.md"), 2, null, "~/notes/"],
    ["past a literal ~", outside("~/x/notes/a.md"), 2, null, "notes/"],
    ["a literal ~ with home known", outside("~/notes/a.md"), 3, HOME, "~/notes/"],
    // The workspace no longer stops the walk.
    [
      "a workspace file",
      inWorkspace("docs/review-pipeline/glossary.md"),
      2,
      HOME,
      "review-pipeline/",
    ],
    [
      "a workspace file, deeper",
      inWorkspace("docs/review-pipeline/glossary.md"),
      3,
      HOME,
      "docs/review-pipeline/",
    ],
    ["a workspace root file", inWorkspace("README.md", "/home/me/code/proj"), 2, HOME, "proj/"],
    [
      "a workspace root file reaching home",
      inWorkspace("README.md", "/home/me/code/proj"),
      3,
      HOME,
      "~/code/proj/",
    ],
    ["a workspace in home", inWorkspace("README.md", "/home/me/proj"), 2, HOME, "~/proj/"],
    ["a workspace at home", inWorkspace("README.md", HOME), 2, HOME, "~/"],
    ["a workspace at home, one folder", inWorkspace("notes/a.md", HOME), 2, HOME, "~/notes/"],
    ["a workspace at root", inWorkspace("a.md", ""), 2, null, "/"],
    ["a POSIX folder named like a drive", inWorkspace("C:/a.md", ""), 2, null, "/C:/"],
    ["a workspace folder named like a drive", inWorkspace("C:/docs/a.md"), 3, HOME, "C:/docs/"],
    // `..` and `.` fold before the walk.
    ["a .. reaching home", outside("/home/me/proj/../a.md"), 2, HOME, "~/"],
    ["a .. outside home", outside("/home/me/proj/../x/y/a.ts"), 2, HOME, "y/"],
    ["a .. past root", outside("/a/../../b/c.md"), 3, HOME, "/b/"],
    ["a .. that names a parent", inWorkspace("docs/guides/../glossary.md"), 2, HOME, "docs/"],
    ["folders after a leading ..", outside("../../shared/lib/util.ts"), 4, HOME, "shared/lib/"],
    ["a dot folder", outside("./src/./app.ts"), 3, HOME, "src/"],
    // Windows.
    ["a Windows drive root file", outside("C:\\a.md"), 2, null, "C:/"],
    ["a Windows drive path", outside("C:\\Users\\me\\notes.md"), 2, null, "me/"],
    [
      "a Windows drive path reaching the drive",
      outside("C:\\Users\\me\\notes.md"),
      4,
      null,
      "C:/Users/me/",
    ],
    ["a Windows home", outside("C:\\Users\\me\\notes.md"), 2, "C:\\Users\\me", "~/"],
    [
      "a Windows home in another case",
      outside("c:\\users\\ME\\d\\notes.md"),
      2,
      "C:\\Users\\me",
      "~/d/",
    ],
    [
      "a Windows path on another drive",
      outside("D:\\Users\\me\\notes.md"),
      3,
      "C:\\Users\\me",
      "D:/Users/me/",
    ],
    ["a POSIX home for a Windows path", outside("C:\\home\\me\\a.md"), 2, HOME, "me/"],
    ["a .. at a drive root", outside("C:\\..\\a.md"), 2, null, "C:/"],
    ["a slash-prefixed Windows drive", outside("/C:/Users/me/notes.md"), 3, null, "C:/Users/me/"],
    ["a slash-prefixed Windows home", outside("/C:/Users/me/notes.md"), 3, "C:\\Users\\me", "~/"],
    ["a UNC path", outside("\\\\server\\share\\docs\\a.md"), 3, null, "share/docs/"],
    [
      "a UNC path shows its server",
      outside("\\\\server\\share\\docs\\a.md"),
      5,
      null,
      "server/share/docs/",
    ],
    // A written workspace link shows only the folders it names.
    [
      "a written workspace link",
      written("docs/review-pipeline/glossary.md"),
      5,
      HOME,
      "docs/review-pipeline/",
    ],
    ["a written file name", written("README.md"), 3, HOME, undefined],
    ["a written file name at home", written("README.md", HOME), 2, HOME, undefined],
    [
      "a written ./ link walks on",
      { ...written("./docs/a.md"), filePath: "/home/me/project/docs/a.md" },
      3,
      HOME,
      "~/project/docs/",
    ],
    // An unexpanded `~/` link and a Windows server's Git Bash path use the reported home.
    ["a literal ~ with home at root", outside("~/notes.md"), 2, "/", "/"],
    ["a literal ~ with a .. past home", outside("~/../notes.md"), 2, "/srv/me", "/srv/"],
    [
      "a Git Bash path on a Windows server",
      outside("/c/Users/alex/notes.md"),
      2,
      "C:\\Users\\alex",
      "~/",
      true,
    ],
    ["a Git Bash drive root", outside("/d/a.md"), 2, "C:\\Users\\alex", "D:/", true],
    ["a Git Bash path with no reported home", outside("/d/a.md"), 2, null, "D:/", true],
    ["a /c folder on a POSIX server", outside("/c/a.md"), 2, HOME, "/c/"],
    ["a written link past its own folders", written("docs/../../notes.md"), 5, HOME, undefined],
    ["a link to home itself", outside("~/"), 2, "/srv/me", undefined],
    // No prefix.
    ["a root file named like a repeated file", outside("/home/me/index.ts"), 2, HOME, undefined],
    ["a link to a parent folder", outside("/home/me/one/project/../"), 2, HOME, undefined],
    ["a link to a current folder", outside("/home/me/one/."), 2, HOME, undefined],
    ["a POSIX name with a backslash", outside("/tmp/notes/a\\b.md"), 2, HOME, undefined],
    ["a colliding path", inWorkspace("src/web/index.ts"), 3, HOME, undefined],
    ["a colliding Windows path", outside("C:\\repo\\src\\server\\index.ts"), 3, null, undefined],
  ])("%s", (_name, meta, depth, home, expected, windows = false) => {
    const repeatedNames = repeatedFileNames(collisions);
    expect(fileLinkPathPrefix(meta, { depth, home, windows, repeatedNames })).toBe(expected);
  });
});
