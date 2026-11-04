import * as HostProcess from "@t3tools/shared/HostProcess";
import type { PreviewBrowserMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { fullChromeRelease } from "./previewChrome.ts";

// "native" runs upstream's chrome-headless-shell. On Linux and Windows, "xvfb" runs full Chrome for
// Testing, which gets past x.ai and other sites that block the shell. On Linux with Xvfb, its
// window on a private display also gets past grok.com, whose Cloudflare check loops in headless
// Chrome. On Windows, and on Linux without Xvfb, it runs headless. Both installs stay on disk.

/** The selected mode; reads that fail count as native. */
export const selectedMode = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  return settings.getSettings.pipe(
    Effect.map((current): PreviewBrowserMode => current.previewBrowserMode),
    Effect.orElseSucceed((): PreviewBrowserMode => "native"),
  );
});

/**
 * The returned `executable` and `installed` read the mode at each call and use its browser.
 * `executable` installs it when missing. `installed` only checks.
 */
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
