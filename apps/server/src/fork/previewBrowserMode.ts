import * as HostProcess from "@t3tools/shared/HostProcess";
import type { PreviewBrowserMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { fullChromeRelease } from "./previewChrome.ts";

// Preview browser modes. "native" is upstream's chrome-headless-shell. "xvfb" runs full Chrome for
// Testing on Linux and Windows, for sites that block headless browsers. On Linux it runs headed on
// a private Xvfb display (previewDisplay.ts), or headless when Xvfb is missing. On Windows it stays
// headless. macOS has only the shell, which both modes run. Both installs stay on disk.

/** The selected mode; reads that fail count as native. */
export const selectedMode = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  return settings.getSettings.pipe(
    Effect.map((current): PreviewBrowserMode => current.previewBrowserMode),
    Effect.orElseSucceed((): PreviewBrowserMode => "native"),
  );
});

/** A PreviewBrowser that installs and returns the selected mode's browser at each call. */
export const make = Effect.fn("previewBrowserMode.make")(function* (
  baseDir: string,
  mode: Effect.Effect<PreviewBrowserMode>,
) {
  const shell = PreviewBrowser.previewBrowserRelease(
    yield* HostProcess.Platform,
    yield* HostProcess.Architecture,
  );
  const native = yield* PreviewBrowser.makePreviewBrowser({ baseDir, release: shell });
  const full = shell && fullChromeRelease(shell.platform);
  // macOS has no full Chrome build T3 can unpack, so both modes use the shell there.
  const xvfb = full ? yield* PreviewBrowser.makePreviewBrowser({ baseDir, release: full }) : native;
  const browser = mode.pipe(Effect.map((selected) => (selected === "xvfb" ? xvfb : native)));
  return PreviewBrowser.PreviewBrowser.of({
    executable: Effect.flatMap(browser, (selected) => selected.executable),
    installed: Effect.flatMap(browser, (selected) => selected.installed),
  });
});

export const layer = Layer.effect(
  PreviewBrowser.PreviewBrowser,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* make(config.baseDir, yield* selectedMode);
  }),
);

/** Runs `restart` after each change of mode, so open preview tabs close and the next one starts in the new mode. */
export const restartOnChange = Effect.fn("previewBrowserMode.restartOnChange")(function* (
  restart: () => Promise<void>,
) {
  const settings = yield* ServerSettingsService;
  const changes = yield* settings.subscribeChanges;
  const mode = yield* selectedMode;
  yield* Stream.concat(
    Stream.fromEffect(mode),
    Stream.map(changes, (current) => current.previewBrowserMode),
  ).pipe(
    Stream.changes,
    Stream.drop(1),
    Stream.runForEach(() => Effect.promise(restart)),
    Effect.forkScoped,
  );
});
