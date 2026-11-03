import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { BrowserContext, Page } from "playwright-core";

// Cloudflare Turnstile on grok.com loops in Chrome's new headless mode and passes in headed
// Chrome, so on Linux the preview browser runs headed on a private Xvfb display. Without Xvfb
// it stays headless.
const SCREEN = "1920x1080x24";

/** On Linux, ["Xvfb"] when no PATH directory holds it, so `t3 browser setup` installs it; elsewhere []. */
export const missingDisplayServer = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return [];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = ((yield* HostProcess.Environment).PATH ?? "/usr/bin").split(":");
  for (const directory of directories.filter(Boolean)) {
    if (yield* fs.exists(path.join(directory, "Xvfb")).pipe(Effect.orElseSucceed(() => false))) {
      return [];
    }
  }
  return ["Xvfb"];
}).pipe(Effect.withSpan("previewDisplay.missingDisplayServer"));

/** One Xauthority entry that matches any display (FamilyWild), holding a secret MIT-MAGIC-COOKIE-1. */
export const xauthorityEntry = (cookie: Uint8Array) => {
  const name = new TextEncoder().encode("MIT-MAGIC-COOKIE-1");
  const fields = [new Uint8Array(0), new Uint8Array(0), name, cookie];
  const entry = new Uint8Array(2 + fields.reduce((size, field) => size + 2 + field.length, 0));
  const view = new DataView(entry.buffer);
  view.setUint16(0, 0xffff);
  let offset = 2;
  for (const field of fields) {
    view.setUint16(offset, field.length);
    entry.set(field, offset + 2);
    offset += 2 + field.length;
  }
  return entry;
};

// Headed Chrome can quit when a persistent profile's last window closes, so the profile's start page stays open.
const startPages = new WeakSet<Page>();
export const keepStartPage = (context: BrowserContext) => {
  const page = context.pages()[0];
  if (page) startPages.add(page);
};
export const isStartPage = (page: Page) => startPages.has(page);

class PreviewDisplayError extends Error {
  override readonly name = "PreviewDisplayError";
}

/**
 * Starts one Xvfb on first use and again after it exits; Xvfb stops with the scope.
 * `env` gives Chrome's environment on the display, or undefined when Chrome stays headless.
 */
export const make = Effect.fn("previewDisplay.make")(function* (
  directory: string,
  command = "Xvfb",
) {
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const lock = yield* Semaphore.make(1);
  let current:
    | {
        readonly env: NodeJS.ProcessEnv;
        readonly running: Effect.Effect<boolean>;
        readonly scope: Scope.Closeable;
      }
    | undefined;

  const start = Effect.gen(function* () {
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const authority = path.join(directory, "Xauthority");
    const cookie = crypto.getRandomValues(new Uint8Array(16));
    yield* fs.writeFile(authority, xauthorityEntry(cookie), { mode: 0o600 });
    const child = yield* Scope.fork(scope);
    const spawned = yield* spawner
      .spawn(
        ChildProcess.make(
          command,
          ["-displayfd", "1", "-auth", authority, "-nolisten", "tcp", "-screen", "0", SCREEN],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe", forceKillAfter: "2 seconds" },
        ),
      )
      .pipe(
        Scope.provide(child),
        Effect.asSome,
        // No Xvfb on this host: Chrome stays headless, and the next launch looks again.
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      );
    if (Option.isNone(spawned)) {
      yield* Scope.close(child, Exit.void);
      return undefined;
    }
    const handle = spawned.value;
    let output = "";
    yield* handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Effect.sync(() => (output = (output + text).slice(-2000)))),
      Effect.ignore,
      Effect.forkIn(child),
    );
    const display = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runHead,
      Effect.timeout("10 seconds"),
      Effect.map(Option.getOrElse(() => "")),
      Effect.orElseSucceed(() => ""),
    );
    if (!/^\d+$/.test(display.trim())) {
      yield* Scope.close(child, Exit.void);
      return yield* Effect.fail(
        new PreviewDisplayError(`T3's browser display did not start.\n${output}`.trim()),
      );
    }
    return {
      env: { DISPLAY: `:${display.trim()}`, XAUTHORITY: authority },
      running: handle.isRunning.pipe(Effect.orElseSucceed(() => false)),
      scope: child,
    };
  });

  const env = (base: NodeJS.ProcessEnv) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (platform !== "linux") return undefined;
        if (current && !(yield* current.running)) {
          // Chrome on the old display has lost its screen; the next launch gets a new one.
          yield* Scope.close(current.scope, Exit.void);
          current = undefined;
        }
        current ??= yield* start;
        return current && { ...base, ...current.env };
      }),
    );

  return { env: (base: NodeJS.ProcessEnv) => runPromise(env(base)) };
});
