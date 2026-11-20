import type { ProviderInstanceConfigMap, ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as Settings from "../../serverSettings.ts";
import {
  deriveDeclaredHomes,
  makeHomeProvisionerRunner,
  serverDeclarerId,
  spawnHomeProvisioner,
  type ProvisionerRequest,
} from "./homeProvisioner.ts";

/**
 * Sends the homes of `instanceConfigs`, the registry's instance map, to the configured
 * `homeProvisioner` command; with no command set it runs nothing. A settings change runs it only
 * when the request differs from the last applied one. A registry change always runs it, because a
 * rebuilt instance can create its overlay or profile while the request stays the same.
 */
export const layer = (instanceConfigs: (settings: ServerSettings) => ProviderInstanceConfigMap) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const settingsService = yield* Settings.ServerSettingsService;
      const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
      const config = yield* ServerConfig.ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const declarer = yield* serverDeclarerId(config.baseDir);
      const lastApplied = yield* Ref.make<string | null>(null);
      const requestKey = (request: ProvisionerRequest) => JSON.stringify(request);
      const runner = yield* makeHomeProvisionerRunner((request) =>
        spawnHomeProvisioner(request).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.tap((outcome) =>
            outcome.kind === "applied"
              ? Ref.set(lastApplied, requestKey(request))
              : Effect.logWarning("The home provisioner failed", { detail: outcome.detail }),
          ),
        ),
      );

      const sync = Effect.fn("homeProvisioner.sync")(
        function* (always: boolean) {
          const settings = yield* settingsService.getSettings;
          if (settings.homeProvisioner === undefined) return;
          const derived = yield* deriveDeclaredHomes(instanceConfigs(settings), {
            stateDir: config.stateDir,
            managedPolicy: settingsService.managedPolicy,
          });
          const request: ProvisionerRequest = {
            command: settings.homeProvisioner,
            declaration: {
              version: 1,
              declarer,
              homes: derived.homes.map((home) => ({ home })),
            },
          };
          if (!always && requestKey(request) === (yield* Ref.get(lastApplied))) return;
          if (derived.skipped.length > 0) {
            yield* Effect.logWarning("Some provider homes were left out of the declaration", {
              skipped: derived.skipped,
            });
          }
          yield* runner.request(request);
        },
        Effect.catchCause((cause) => Effect.logError("Declaring provider homes failed", cause)),
      );

      const registryChanges = yield* registry.subscribeChanges;
      const settingsChanges = yield* settingsService.subscribeChanges;
      yield* Stream.merge(
        Stream.fromSubscription(registryChanges).pipe(Stream.map(() => true)),
        settingsChanges.pipe(Stream.map(() => false)),
      ).pipe(Stream.runForEach(sync), Effect.forkScoped);
      yield* Effect.forkScoped(sync(true));
    }),
  );
