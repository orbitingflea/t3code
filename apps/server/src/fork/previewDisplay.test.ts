import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as PreviewDisplay from "./previewDisplay.ts";

const onPath = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = yield* HostProcess.Environment;
    for (const directory of (env.PATH ?? "").split(":").filter(Boolean)) {
      const candidate = path.join(directory, name);
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
    }
    return undefined;
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

const xvfb = await onPath("Xvfb");
const xdpyinfo = await onPath("xdpyinfo");
const isLinux = HostProcess.Platform.defaultValue() === "linux";

it("writes one MIT-MAGIC-COOKIE-1 entry that matches any display", () => {
  const cookie = new Uint8Array(16).fill(7);
  const entry = PreviewDisplay.xauthorityEntry(cookie);
  const view = new DataView(entry.buffer);
  expect(view.getUint16(0)).toBe(0xffff);
  expect(view.getUint16(2)).toBe(0);
  expect(view.getUint16(4)).toBe(0);
  expect(view.getUint16(6)).toBe(18);
  expect(new TextDecoder().decode(entry.subarray(8, 26))).toBe("MIT-MAGIC-COOKIE-1");
  expect(view.getUint16(26)).toBe(16);
  expect(entry.subarray(28)).toEqual(cookie);
});

it.layer(NodeServices.layer)("preview display", (it) => {
  const directory = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-display-test-" });
    return { root, display: path.join(root, "display") };
  });

  it.effect("keeps Chrome headless off Linux", () =>
    Effect.gen(function* () {
      const { display } = yield* directory;
      const preview = yield* PreviewDisplay.make(display);
      expect(yield* Effect.promise(() => preview.env({ LANG: "C.UTF-8" }))).toBeUndefined();
    }).pipe(Effect.provideService(HostProcess.Platform, "darwin")),
  );

  it.effect.skipIf(!isLinux || !xvfb)("finds Xvfb once it is installed, without a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, display } = yield* directory;
      const command = path.join(root, "Xvfb");
      const preview = yield* PreviewDisplay.make(display, { command });
      expect(yield* Effect.promise(() => preview.env({}))).toBeUndefined();
      yield* fs.symlink(xvfb!, command);
      expect((yield* Effect.promise(() => preview.env({})))?.DISPLAY).toMatch(/^:\d+$/);
    }),
  );

  it.effect.skipIf(!isLinux || !xvfb)(
    "starts one private display and stops it with its scope",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { display } = yield* directory;
        const scope = yield* Scope.make();
        const preview = yield* PreviewDisplay.make(display).pipe(Scope.provide(scope));
        const [env, again] = yield* Effect.promise(() =>
          Promise.all([preview.env({ LANG: "C.UTF-8" }), preview.env({ LANG: "en_GB.UTF-8" })]),
        );
        expect(env).toMatchObject({
          LANG: "C.UTF-8",
          DISPLAY: expect.stringMatching(/^:\d+$/),
          XAUTHORITY: path.join(display, "Xauthority"),
        });
        expect(again?.DISPLAY).toBe(env?.DISPLAY);
        expect((yield* fs.stat(env!.XAUTHORITY!)).mode & 0o777).toBe(0o600);
        if (!xdpyinfo) return yield* Scope.close(scope, Exit.void);
        // xdpyinfo exits 0 only when it can open the display.
        const probe = (authority: string) =>
          spawner.exitCode(
            ChildProcess.make(xdpyinfo, [], {
              env: { DISPLAY: env!.DISPLAY, XAUTHORITY: authority },
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          );
        expect(yield* probe(env!.XAUTHORITY!)).toBe(0);
        expect(yield* probe(path.join(display, "missing"))).not.toBe(0);
        yield* Scope.close(scope, Exit.void);
        expect(yield* probe(env!.XAUTHORITY!)).not.toBe(0);
      }),
  );
});
