import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type PreviewBrowserMode } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";

import { previewBrowserRelease } from "../preview/PreviewBrowser.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as BrowserMode from "./previewBrowserMode.ts";
import { fullChromeRelease } from "./previewChrome.ts";
import * as PreviewDisplay from "./previewDisplay.ts";

it("defaults to T3 native", () => {
  expect(DEFAULT_SERVER_SETTINGS.previewBrowserMode).toBe("native");
});

it.layer(NodeServices.layer)("preview browser mode", (it) => {
  const installBoth = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-mode-test-" });
    const executables = [];
    for (const release of [previewBrowserRelease("linux", "x64")!, fullChromeRelease("linux64")!]) {
      const product = release.product ?? "chrome-headless-shell";
      const directory = path.join(baseDir, "tools", product, release.platform, release.version);
      yield* fs.makeDirectory(directory, { recursive: true });
      const executable = path.join(directory, release.executable ?? product);
      yield* fs.writeFileString(executable, "#!/bin/sh\n", { mode: 0o755 });
      executables.push(executable);
    }
    const [shell, chrome] = executables;
    return { baseDir, shell: shell!, chrome: chrome! };
  });

  it.effect("runs chrome-headless-shell in native mode and full Chrome in Xvfb mode", () =>
    Effect.gen(function* () {
      const { baseDir, shell, chrome } = yield* installBoth;
      const mode = yield* Ref.make<PreviewBrowserMode>("native");
      const browser = yield* BrowserMode.make(baseDir, Ref.get(mode));
      expect(yield* browser.executable).toBe(shell);
      yield* Ref.set(mode, "xvfb");
      expect(yield* browser.executable).toBe(chrome);
      yield* Ref.set(mode, "native");
      expect(yield* browser.executable).toBe(shell);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(shell)).toBe(true);
      expect(yield* fs.exists(chrome)).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Architecture, "x64"),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("installed browsers need no download")),
      ),
    ),
  );

  it.effect("starts no display in native mode and starts one in Xvfb mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-browser-mode-display-" });
      const marker = path.join(root, "started");
      // Stands in for Xvfb: records that it ran and reports display 42.
      const command = path.join(root, "Xvfb");
      yield* fs.writeFileString(command, `#!/bin/sh\ntouch '${marker}'\necho 42\nexec sleep 30\n`, {
        mode: 0o755,
      });
      const mode = yield* Ref.make<PreviewBrowserMode>("native");
      const display = yield* PreviewDisplay.make(path.join(root, "display"), {
        command,
        enabled: Effect.map(Ref.get(mode), (selected) => selected === "xvfb"),
      });

      expect(yield* Effect.promise(() => display.env({}))).toBeUndefined();
      expect(yield* fs.exists(marker)).toBe(false);

      yield* Ref.set(mode, "xvfb");
      expect((yield* Effect.promise(() => display.env({})))?.DISPLAY).toBe(":42");
      expect(yield* fs.exists(marker)).toBe(true);

      yield* Ref.set(mode, "native");
      expect(yield* Effect.promise(() => display.env({}))).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("restarts the browser when the mode changes, not on other settings", () =>
    Effect.gen(function* () {
      const base = yield* ServerSettingsService;
      const changes = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
      const restarts = yield* Queue.unbounded<void>();
      yield* BrowserMode.restartOnChange(async () => {
        Queue.offerUnsafe(restarts, undefined);
      }).pipe(
        Effect.provideService(ServerSettingsService, {
          ...base,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          subscribeChanges: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
        }),
      );
      const publish = (patch: Partial<typeof DEFAULT_SERVER_SETTINGS>) =>
        PubSub.publish(changes, { ...DEFAULT_SERVER_SETTINGS, ...patch });

      yield* publish({ enableProviderUpdateChecks: false });
      yield* publish({ previewBrowserMode: "xvfb" });
      yield* publish({ previewBrowserMode: "xvfb", enableAgentBrowserAccess: false });
      yield* publish({ previewBrowserMode: "native" });
      yield* publish({ previewBrowserMode: "xvfb" });
      // Changes run in order, so after the third restart any extra one would already be queued.
      yield* Queue.takeN(restarts, 3);
      expect(yield* Queue.size(restarts)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(ServerSettingsService.layerTest())),
  );
});
