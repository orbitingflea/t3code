import {
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type DeclaredHome,
  HomeDeclarationWireV1,
  type HomeProvisionerCommand,
  type ManagedPolicySummary,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { disallowedDriverReason } from "../../policy/managedProviders.ts";
import { resolveAntigravityInstanceDirectories } from "../../provider/antigravityAuthSupport.ts";
import { resolveManagedCodexHomeLayout } from "../../provider/CodexManagedHome.ts";
import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../../provider/Drivers/CodexHomeLayout.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const encodeDeclaration = Schema.encodeEffect(Schema.fromJsonString(HomeDeclarationWireV1));

const homeKey = (home: DeclaredHome): string =>
  home.agent === "claude"
    ? `claude:${home.configDir}`
    : home.agent === "codex"
      ? `codex:${home.codexHome}`
      : `agy:${home.geminiDir}`;

export interface DerivedHomes {
  readonly homes: ReadonlyArray<DeclaredHome>;
  /** Instances whose homes could not be read from their settings, one line each. */
  readonly skipped: ReadonlyArray<string>;
}

/**
 * The homes of the enabled instances in the instance map the registry runs from, minus drivers
 * the managed policy blocks. Live instances are not used: an instance waiting on a secret, or one
 * whose driver failed to start, still owns its home, and dropping it would retire that home's
 * hooks. Upstream resolvers name each home, so the list matches what each driver uses.
 */
export const deriveDeclaredHomes = Effect.fn("homeProvisioner.deriveDeclaredHomes")(function* (
  instances: ProviderInstanceConfigMap,
  options: {
    readonly stateDir: string;
    readonly managedPolicy?: ManagedPolicySummary | undefined;
  },
) {
  const hostEnvironment = yield* HostProcess.Environment;
  const homes = new Map<string, DeclaredHome>();
  const skipped: Array<string> = [];
  const add = (home: DeclaredHome) => {
    if (!homes.has(homeKey(home))) homes.set(homeKey(home), home);
  };

  for (const [rawId, entry] of Object.entries(instances)) {
    if (!resolveProviderInstanceEnabled(entry)) continue;
    if (disallowedDriverReason(options.managedPolicy, entry.driver) !== undefined) continue;
    const instanceId = ProviderInstanceId.make(rawId);
    const environment = yield* mergeProviderInstanceEnvironment(entry.environment, hostEnvironment);
    switch (entry.driver) {
      case "claudeAgent": {
        const config = decodeClaudeSettings(entry.config ?? {});
        if (Option.isNone(config)) {
          skipped.push(`${instanceId}: its Claude settings do not decode.`);
          break;
        }
        add({
          agent: "claude",
          configDir: yield* resolveClaudeHomePath(config.value, environment),
        });
        break;
      }
      case "codex": {
        const decoded = decodeCodexSettings(entry.config ?? {});
        if (Option.isNone(decoded)) {
          skipped.push(`${instanceId}: its Codex settings do not decode.`);
          break;
        }
        const config = decoded.value;
        // Same fallback as the Codex driver: an unset home path follows CODEX_HOME.
        const layout =
          config.setupMode === "managed"
            ? yield* resolveManagedCodexHomeLayout(options.stateDir, instanceId, config)
            : yield* resolveCodexHomeLayout(
                config.homePath.trim().length === 0 && environment.CODEX_HOME?.trim()
                  ? { ...config, homePath: environment.CODEX_HOME }
                  : config,
              );
        // The base owns the hooks.json and config.toml an overlay links, so it is declared first.
        if (layout.mode === "authOverlay")
          add({ agent: "codex", codexHome: layout.sharedHomePath });
        add({ agent: "codex", codexHome: layout.effectiveHomePath ?? layout.sharedHomePath });
        break;
      }
      case "antigravity": {
        const directories = yield* resolveAntigravityInstanceDirectories(
          options.stateDir,
          instanceId,
        );
        add({ agent: "agy", geminiDir: directories.profile });
        break;
      }
    }
  }
  return { homes: [...homes.values()], skipped } satisfies DerivedHomes;
});

/** Dev and packaged servers keep different base folders, so their declarations never clash. */
export const serverDeclarerId = Effect.fn("homeProvisioner.serverDeclarerId")(function* (
  baseDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const real = yield* fileSystem
    .realPath(baseDir)
    .pipe(Effect.orElseSucceed(() => path.resolve(baseDir)));
  const hash = yield* digest.digest(Digest.sha256, new TextEncoder().encode(real));
  return `t3code:${Hex.encode(hash).slice(0, 8)}`;
});

export type ProvisionerOutcome =
  | { readonly kind: "applied"; readonly output: string }
  | { readonly kind: "failed"; readonly detail: string };

export interface ProvisionerRequest {
  readonly command: HomeProvisionerCommand;
  readonly declaration: HomeDeclarationWireV1;
}

export type ProvisionerWait =
  | { readonly kind: "finished"; readonly outcome: ProvisionerOutcome }
  /** The run goes on in the background; a later request still waits for its own run. */
  | { readonly kind: "stillRunning" };

export interface HomeProvisionerRunner {
  readonly request: (request: ProvisionerRequest) => Effect.Effect<ProvisionerWait>;
}

const HARD_LIMIT = Duration.minutes(2);
const OUTPUT_LIMIT_BYTES = 16 * 1024;

/** Reads the whole stream, so the child never blocks on a full pipe, and keeps its first 16 KiB. */
const readText = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.runFold(
    stream,
    () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
    (kept, chunk) => {
      const room = OUTPUT_LIMIT_BYTES - kept.size;
      if (room > 0) {
        const part = chunk.subarray(0, room);
        kept.chunks.push(part);
        kept.size += part.length;
      }
      return kept;
    },
  ).pipe(Effect.map((kept) => new TextDecoder().decode(Buffer.concat(kept.chunks))));

/**
 * Runs the command once with the declaration on stdin. The 2-minute limit stops the command even
 * halfway through writing a home. Never fails: errors become an outcome.
 */
export const spawnHomeProvisioner = Effect.fn("homeProvisioner.spawn")(function* (
  request: ProvisionerRequest,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [command, ...args] = request.command;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const input = yield* encodeDeclaration(request.declaration);
      const child = yield* spawner.spawn(
        ChildProcess.make(command!, args, {
          stdin: { stream: Stream.encodeText(Stream.make(input)) },
          forceKillAfter: "5 seconds",
        }),
      );
      const [output, errors, exitCode] = yield* Effect.all(
        [readText(child.stdout), readText(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      return exitCode === 0
        ? ({ kind: "applied", output: output.trim() } satisfies ProvisionerOutcome)
        : ({
            kind: "failed",
            detail: `exited with ${exitCode}: ${(errors.trim() || output.trim()).slice(0, 2000)}`,
          } satisfies ProvisionerOutcome);
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: HARD_LIMIT,
      orElse: () =>
        Effect.succeed<ProvisionerOutcome>({
          kind: "failed",
          detail: `did not finish within ${Duration.format(HARD_LIMIT)}.`,
        }),
    }),
    Effect.catch((cause) =>
      Effect.succeed<ProvisionerOutcome>({ kind: "failed", detail: cause.message }),
    ),
  );
});

interface PendingRun {
  readonly request: ProvisionerRequest;
  readonly done: Deferred.Deferred<ProvisionerOutcome>;
}

interface RunnerState {
  readonly current: PendingRun | null;
  /** The run that starts when the current one ends; later requests replace its request. */
  readonly trailing: PendingRun | null;
}

const IDLE: RunnerState = { current: null, trailing: null };

/**
 * One run at a time; requests made during a run merge into one trailing run with the newest
 * request. A caller waits up to `awaitCap`, and the run goes on in the runner's scope after that.
 * A run that dies becomes a failed outcome and an interrupted worker frees the runner.
 */
export const makeHomeProvisionerRunner = Effect.fn("homeProvisioner.makeRunner")(function* (
  apply: (request: ProvisionerRequest) => Effect.Effect<ProvisionerOutcome>,
  options: { readonly awaitCap: Duration.Input } = { awaitCap: "5 seconds" },
) {
  const scope = yield* Effect.scope;
  const state = yield* Ref.make<RunnerState>(IDLE);

  const runOne = (run: PendingRun) =>
    apply(run.request).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("The home provisioner run failed", cause).pipe(
          Effect.as<ProvisionerOutcome>({ kind: "failed", detail: Cause.pretty(cause) }),
        ),
      ),
      Effect.flatMap((outcome) => Deferred.succeed(run.done, outcome)),
    );

  const release = Ref.getAndSet(state, IDLE).pipe(
    Effect.flatMap(({ current, trailing }) =>
      Effect.forEach(
        [current, trailing],
        (run) =>
          run === null
            ? Effect.void
            : Deferred.succeed(run.done, { kind: "failed", detail: "was stopped." }),
        { discard: true },
      ),
    ),
  );

  const drain = Effect.gen(function* () {
    let current = (yield* Ref.get(state)).current;
    while (current !== null) {
      yield* runOne(current);
      current = yield* Ref.modify(state, (now): readonly [PendingRun | null, RunnerState] => [
        now.trailing,
        { current: now.trailing, trailing: null },
      ]);
    }
  }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : release)));

  const request = Effect.fn("homeProvisioner.request")(function* (next: ProvisionerRequest) {
    const fresh = yield* Deferred.make<ProvisionerOutcome>();
    // Claim and fork together, so an interrupt cannot leave a claimed runner with no worker.
    const done = yield* Effect.uninterruptible(
      Ref.modify(
        state,
        (
          now,
        ): readonly [
          { readonly start: boolean; readonly done: PendingRun["done"] },
          RunnerState,
        ] => {
          if (now.current === null) {
            return [
              { start: true, done: fresh },
              { current: { request: next, done: fresh }, trailing: null },
            ];
          }
          const done = now.trailing?.done ?? fresh;
          return [
            { start: false, done },
            { current: now.current, trailing: { request: next, done } },
          ];
        },
      ).pipe(
        Effect.tap((action) =>
          action.start ? Effect.forkIn(Effect.interruptible(drain), scope) : Effect.void,
        ),
        Effect.map((action) => action.done),
      ),
    );
    return yield* Deferred.await(done).pipe(
      Effect.map((outcome): ProvisionerWait => ({ kind: "finished", outcome })),
      Effect.timeoutOrElse({
        duration: options.awaitCap,
        orElse: () => Effect.succeed<ProvisionerWait>({ kind: "stillRunning" }),
      }),
    );
  });

  return { request } satisfies HomeProvisionerRunner;
});
