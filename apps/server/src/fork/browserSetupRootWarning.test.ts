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

const setupOutput = (baseDirOwner: number) =>
  Effect.gen(function* () {
    yield* Command.runWith(browserCommand, { version: "0.0.0" })([
      "setup",
      "--base-dir",
      "/srv/t3",
    ]).pipe(
      Effect.provide(
        FileSystem.layerNoop({
          exists: () => Effect.succeed(true),
          stat: () =>
            Effect.succeed({
              type: "Directory",
              uid: Option.some(baseDirOwner),
            } as FileSystem.File.Info),
        }),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, readyHostSpawner),
      Effect.provideService(HostProcess.Platform, "linux"),
      // Root without sudo, as from `incus exec` or a root shell.
      Effect.provideService(HostProcess.UserId, 0),
      Effect.provideService(HostProcess.Environment, {}),
    );
    return (yield* TestConsole.logLines).join("\n");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Layer.fresh(TestConsole.layer))));

it.effect("root setup warns only when root owns the server's T3 home", () =>
  Effect.gen(function* () {
    expect(yield* setupOutput(0)).toContain("T3 server is running as root");
    expect(yield* setupOutput(1000)).not.toContain("running as root");
  }),
);
