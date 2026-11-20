import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import * as Settings from "../../serverSettings.ts";
import { layer } from "./homeProvisionerLayer.ts";

const claude = ProviderDriverKind.make("claudeAgent");

it.effect("runs on a registry change, and on a settings change only when the request changed", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-provision-layer-" });
    const settings = yield* Ref.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
    const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
    const registryChanges = yield* PubSub.unbounded<void>();
    const settingsReads = yield* Queue.unbounded<void>();
    const readPermits = yield* Queue.unbounded<void>();
    const settingsRead = yield* Queue.unbounded<void>();
    const runs = yield* Ref.make(0);
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed({
        stdout: Stream.empty,
        stderr: Stream.empty,
        exitCode: Ref.update(runs, (count) => count + 1).pipe(Effect.as(0)),
      } as unknown as ChildProcessSpawner.ChildProcessHandle),
    );

    yield* Layer.build(
      layer(deriveProviderInstanceConfigMap).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Settings.ServerSettingsService)({
              getSettings: Queue.offer(settingsReads, undefined).pipe(
                Effect.andThen(Queue.take(readPermits)),
                Effect.andThen(Ref.get(settings)),
                Effect.tap(() => Queue.offer(settingsRead, undefined)),
              ),
              subscribeChanges: Effect.succeed(Stream.fromPubSub(settingsChanges)),
            }),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              subscribeChanges: PubSub.subscribe(registryChanges),
            }),
            ServerConfig.layerTest(root, root),
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(HostProcess.HomeDirectory, path.join(root, "home")),
            Layer.succeed(HostProcess.Environment, {}),
          ),
        ),
      ),
    );
    // Each change pauses at its settings read. The layer handles one change at a time, so a paused
    // change means the one before it is done; releasing it lets it read settings and go on.
    const awaitPaused = Queue.take(settingsReads);
    const release = Queue.offer(readPermits, undefined).pipe(
      Effect.andThen(Queue.take(settingsRead)),
    );
    const changeSettings = (patch: Partial<ServerSettings>) =>
      Ref.updateAndGet(settings, (current) => ({ ...current, ...patch })).pipe(
        Effect.flatMap((next) => PubSub.publish(settingsChanges, next)),
        Effect.andThen(awaitPaused),
      );
    const unrelatedChange = changeSettings({
      defaultTheme: "an-unrelated-theme",
    } as Partial<ServerSettings>);
    const runsSoFar = Ref.get(runs);

    yield* awaitPaused;
    yield* release;
    yield* changeSettings({ homeProvisioner: ["provisioner"] });
    yield* release;
    yield* unrelatedChange;
    assert.strictEqual(yield* runsSoFar, 1, "setting the command runs it");
    yield* release;
    yield* changeSettings({
      providerInstances: { claude_work: { driver: claude } } as ServerSettings["providerInstances"],
    });
    assert.strictEqual(yield* runsSoFar, 1, "an unrelated settings change is skipped");
    yield* release;
    yield* PubSub.publish(registryChanges, undefined).pipe(Effect.andThen(awaitPaused));
    assert.strictEqual(yield* runsSoFar, 2, "a new home runs");
    yield* release;
    yield* unrelatedChange;
    assert.strictEqual(yield* runsSoFar, 3, "a registry change runs with the same request");
    yield* release;
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
