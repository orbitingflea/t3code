// @effect-diagnostics nodeBuiltinImport:off - Starts a real Xvfb and checks its files outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { PreviewDisplay, xauthorityEntry } from "./previewDisplay.ts";

const hasXvfb = (process.env.PATH ?? "")
  .split(":")
  .some((directory) => directory && NodeFS.existsSync(NodePath.join(directory, "Xvfb")));
const hasXdpyinfo = (process.env.PATH ?? "")
  .split(":")
  .some((directory) => directory && NodeFS.existsSync(NodePath.join(directory, "xdpyinfo")));

const directories: string[] = [];
const tempDirectory = async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-display-"));
  directories.push(directory);
  return NodePath.join(directory, "display");
};

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

describe("xauthorityEntry", () => {
  it("writes one MIT-MAGIC-COOKIE-1 entry that matches any display", () => {
    const cookie = Buffer.alloc(16, 7);
    const entry = xauthorityEntry(cookie);
    expect(entry.readUInt16BE(0)).toBe(0xffff);
    expect(entry.readUInt16BE(2)).toBe(0);
    expect(entry.readUInt16BE(4)).toBe(0);
    expect(entry.readUInt16BE(6)).toBe(18);
    expect(entry.subarray(8, 26).toString()).toBe("MIT-MAGIC-COOKIE-1");
    expect(entry.readUInt16BE(26)).toBe(16);
    expect(entry.subarray(28)).toEqual(cookie);
  });
});

describe("PreviewDisplay", () => {
  it("keeps Chrome headless off Linux", async () => {
    const display = new PreviewDisplay({ platform: "darwin", directory: await tempDirectory() });
    expect(await display.env({ HOME: "/home/test" })).toBeUndefined();
  });

  it("keeps Chrome headless when Xvfb is not installed", async () => {
    const display = new PreviewDisplay({
      platform: "linux",
      directory: await tempDirectory(),
      command: "/nonexistent/Xvfb",
    });
    expect(await display.env({})).toBeUndefined();
  });

  it.skipIf(!hasXvfb)("starts one private display and stops it on close", async () => {
    const directory = await tempDirectory();
    const display = new PreviewDisplay({ platform: "linux", directory });
    const [env, again] = await Promise.all([
      display.env({ HOME: "/home/test" }),
      display.env({ HOME: "/home/other" }),
    ]);
    expect(env).toMatchObject({
      HOME: "/home/test",
      DISPLAY: expect.stringMatching(/^:\d+$/),
      XAUTHORITY: NodePath.join(directory, "Xauthority"),
    });
    expect(again?.DISPLAY).toBe(env?.DISPLAY);
    expect((await NodeFSP.stat(env!.XAUTHORITY!)).mode & 0o777).toBe(0o600);
    if (hasXdpyinfo) {
      const probe = (extra: NodeJS.ProcessEnv) =>
        NodeChildProcess.spawnSync("xdpyinfo", [], {
          env: { PATH: process.env.PATH, DISPLAY: env!.DISPLAY, ...extra },
        }).status;
      expect(probe({ XAUTHORITY: env!.XAUTHORITY })).toBe(0);
      expect(probe({ XAUTHORITY: "/nonexistent" })).not.toBe(0);
    }
    await display.close();
    expect(await display.env({})).toBeUndefined();
  });
});
