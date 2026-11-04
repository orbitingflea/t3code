import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { ChildProcessSpawner } from "effect/process";

import { browserCommand } from "../cli/browser.ts";

// Every check passes, so setup changes nothing and only reports.
const readyHostSpawner = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.encodeText(Stream.make("/fonts/sans.ttf")),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);

// Setup runs as root without sudo, as in a container or a root shell.
const rootSetupOutput = (input: { readonly baseDir?: string; readonly baseDirOwner?: number }) =>
  Effect.gen(function* () {
    const { baseDirOwner } = input;
    yield* Command.runWith(browserCommand, { version: "0.0.0" })([
      "setup",
      ...(input.baseDir === undefined ? [] : ["--base-dir", input.baseDir]),
    ]).pipe(
      Effect.provide(
        FileSystem.layerNoop({
          exists: () => Effect.succeed(true),
          ...(baseDirOwner === undefined
            ? {}
            : {
                stat: () =>
                  Effect.succeed({
                    type: "Directory",
                    uid: Option.some(baseDirOwner),
                  } as FileSystem.File.Info),
              }),
        }),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, readyHostSpawner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.UserId, 0),
      Effect.provideService(HostProcess.Environment, {}),
    );
    return (yield* TestConsole.logLines).join("\n");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Layer.fresh(TestConsole.layer))));

it.effect("root setup warns by the owner of a given T3 home, and conditionally without one", () =>
  Effect.gen(function* () {
    expect(yield* rootSetupOutput({ baseDir: "/srv/t3", baseDirOwner: 0 })).toContain(
      "The T3 home /srv/t3 belongs to root",
    );
    expect(yield* rootSetupOutput({ baseDir: "/srv/t3", baseDirOwner: 1000 })).not.toContain(
      "root",
    );
    // A fresh install has no T3 home yet.
    const missingHome = yield* rootSetupOutput({ baseDir: "/srv/t3" });
    expect(missingHome).toContain("Setup could not read the owner of the T3 home /srv/t3");
    expect(missingHome).not.toContain("--base-dir");
    // Without --base-dir, setup looks at root's own T3 home, which says nothing about the server.
    const defaultHome = yield* rootSetupOutput({ baseDirOwner: 0 });
    expect(defaultHome).toContain("cannot tell which user runs the T3 server");
    expect(defaultHome).not.toContain("belongs to root");
    expect(defaultHome).not.toContain("is running as root");
  }),
);
