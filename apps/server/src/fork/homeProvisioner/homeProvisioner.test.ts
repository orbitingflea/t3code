import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  type HomeDeclarationWireV1,
  type ManagedPolicySummary,
  type ServerSettings,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { CodexSettings, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { resolveAntigravityInstanceDirectories } from "../../provider/antigravityAuthSupport.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../../provider/Drivers/CodexHomeLayout.ts";
import {
  HOOK_STATE_DB_ENV,
  PROVIDER_INSTANCE_ID_ENV,
  withProviderProcessIdentity,
  withProviderProcessIdentityEnv,
} from "../instanceIdentity.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import {
  deriveDeclaredHomes,
  makeHomeProvisionerRunner,
  serverDeclarerId,
  spawnHomeProvisioner,
  type ProvisionerOutcome,
  type ProvisionerRequest,
  type ProvisionerWait,
} from "./homeProvisioner.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const antigravity = ProviderDriverKind.make("antigravity");
const instance = ProviderInstanceId.make;
const STATE_DB = "/srv/t3/userdata/statev2.sqlite";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const settingsWith = (
  providerInstances: Record<string, unknown>,
  overrides: Partial<ServerSettings> = {},
): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: providerInstances as ServerSettings["providerInstances"],
  ...overrides,
});

const request = (label: string): ProvisionerRequest => ({
  command: ["provisioner"],
  declaration: {
    version: 1,
    declarer: "t3code:test",
    homes: [{ home: { agent: "claude", configDir: label } }],
  },
});

describe("withProviderProcessIdentityEnv", () => {
  it("adds the instance id and state database and never T3CODE_HOME", () => {
    const environment = withProviderProcessIdentityEnv(instance("claude_work"), STATE_DB, [
      { name: "ANTHROPIC_BASE_URL", value: "http://proxy", sensitive: false },
      { name: PROVIDER_INSTANCE_ID_ENV, value: "spoofed", sensitive: false },
    ]);
    assert.deepStrictEqual(environment, [
      { name: "ANTHROPIC_BASE_URL", value: "http://proxy", sensitive: false },
      { name: PROVIDER_INSTANCE_ID_ENV, value: "claude_work", sensitive: false },
      { name: HOOK_STATE_DB_ENV, value: STATE_DB, sensitive: false },
    ]);
    assert.notInclude(
      environment.map((variable) => variable.name),
      "T3CODE_HOME",
    );
  });

  it.effect("reaches each driver's create call and a process spawned from it", () =>
    Effect.gen(function* () {
      const created = yield* Ref.make<ReadonlyArray<string>>([]);
      const driver = {
        driverKind: claude,
        create: (input: Parameters<AnyProviderDriver["create"]>[0]) =>
          Ref.update(created, (names) => [
            ...names,
            ...input.environment.map((variable) => `${variable.name}=${variable.value}`),
          ]).pipe(Effect.as({} as never)),
      } as unknown as AnyProviderDriver;
      const [wrapped] = withProviderProcessIdentity([driver], STATE_DB);
      const environment = withProviderProcessIdentityEnv(instance("claude_b"), STATE_DB, []);
      yield* wrapped!.create({
        instanceId: instance("claude_b"),
        displayName: undefined,
        environment: [],
        enabled: true,
        config: {},
      });
      assert.deepStrictEqual(yield* Ref.get(created), [
        `${PROVIDER_INSTANCE_ID_ENV}=claude_b`,
        `${HOOK_STATE_DB_ENV}=${STATE_DB}`,
      ]);

      const processEnvironment = yield* mergeProviderInstanceEnvironment(environment, {
        PATH: "/usr/bin:/bin",
      });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const printed = yield* spawner.string(
        ChildProcess.make(
          process.execPath,
          [
            "-e",
            "process.stdout.write(JSON.stringify([process.env.T3CODE_PROVIDER_INSTANCE_ID, process.env.T3CODE_HOOK_STATE_DB, process.env.T3CODE_HOME ?? null]))",
          ],
          { env: processEnvironment, extendEnv: false },
        ),
      );
      assert.deepStrictEqual(JSON.parse(printed), ["claude_b", STATE_DB, null]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("deriveDeclaredHomes", () => {
  const derive = (
    settings: ServerSettings,
    environment: NodeJS.ProcessEnv = {},
    managedPolicy?: ManagedPolicySummary,
  ) =>
    deriveDeclaredHomes(deriveProviderInstanceConfigMap(settings), {
      stateDir: "/srv/t3/userdata",
      managedPolicy,
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/agent"),
      Effect.provideService(HostProcess.Environment, environment),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );

  it.effect("lists each enabled instance's home from settings, including unavailable ones", () =>
    Effect.gen(function* () {
      const derived = yield* derive(
        settingsWith({
          claude_work: { driver: claude, config: { homePath: "~/slots/work/.claude" } },
          claude_locked: {
            driver: claude,
            environment: [
              { name: "CLAUDE_CONFIG_DIR", value: "/slots/locked", sensitive: false },
              {
                name: "ANTHROPIC_API_KEY",
                value: "",
                sensitive: true,
                secret: { provider: SecretProviderId.make("vault"), secretName: "missing" },
              },
            ],
          },
          claude_off: { driver: claude, enabled: false, config: { homePath: "/slots/off" } },
          codex_overlay: {
            driver: codex,
            config: { homePath: "/codex/base", shadowHomePath: "/codex/overlays/a" },
          },
          codex_env: {
            driver: codex,
            environment: [{ name: "CODEX_HOME", value: "/codex/from-env", sensitive: false }],
          },
          agy: { driver: antigravity, enabled: true },
          broken: { driver: claude, config: { homePath: 42 } },
        }),
      );
      const agyProfile = (yield* resolveAntigravityInstanceDirectories(
        "/srv/t3/userdata",
        instance("agy"),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))).profile;

      assert.deepStrictEqual(derived.homes, [
        { agent: "claude", configDir: "/home/agent/slots/work/.claude" },
        { agent: "claude", configDir: "/slots/locked" },
        { agent: "codex", codexHome: "/codex/base" },
        { agent: "codex", codexHome: "/codex/overlays/a" },
        { agent: "codex", codexHome: "/codex/from-env" },
        { agent: "agy", geminiDir: agyProfile },
        { agent: "codex", codexHome: "/home/agent/.codex" },
        { agent: "claude", configDir: "/home/agent/.claude" },
      ]);
      assert.deepStrictEqual(derived.skipped, ["broken: its Claude settings do not decode."]);
    }),
  );

  it.effect("declares a project-enabled instance and drops duplicate homes", () =>
    Effect.gen(function* () {
      const derived = yield* derive(
        settingsWith(
          {
            codex: { driver: codex, enabled: false },
            claudeAgent: { driver: claude, enabled: false },
            claude_project: { driver: claude, enabled: false, config: { homePath: "/p/.claude" } },
            claude_same: { driver: claude, config: { homePath: "/p/.claude" } },
          },
          {
            projectSettingsOverrides: {
              project: { providerInstances: { claude_project: { enabled: true } } },
            } as unknown as ServerSettings["projectSettingsOverrides"],
          },
        ),
      );
      assert.deepStrictEqual(derived.homes, [{ agent: "claude", configDir: "/p/.claude" }]);
    }),
  );

  it.effect(
    "declares a default instance a project turns on and skips drivers a policy blocks",
    () =>
      Effect.gen(function* () {
        const settings = settingsWith(
          { codex: { driver: codex, enabled: false } },
          {
            projectSettingsOverrides: {
              project: { providerInstances: { antigravity: { enabled: true } } },
            } as unknown as ServerSettings["projectSettingsOverrides"],
          },
        );
        const agyProfile = (yield* resolveAntigravityInstanceDirectories(
          "/srv/t3/userdata",
          instance("antigravity"),
        ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))).profile;
        assert.deepStrictEqual((yield* derive(settings)).homes, [
          { agent: "claude", configDir: "/home/agent/.claude" },
          { agent: "agy", geminiDir: agyProfile },
        ]);
        const claudeOnly: ManagedPolicySummary = {
          organization: "Example",
          lockedSettings: [],
          limits: { providers: { allowedDrivers: [claude] } },
        };
        assert.deepStrictEqual((yield* derive(settings, {}, claudeOnly)).homes, [
          { agent: "claude", configDir: "/home/agent/.claude" },
        ]);
      }),
  );
});

describe("serverDeclarerId", () => {
  it.effect("names the server by its real base folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-declarer-" });
      const base = path.join(root, "base");
      yield* fileSystem.makeDirectory(base);
      const id = yield* serverDeclarerId(base);
      assert.match(id, /^t3code:[0-9a-f]{8}$/);
      if (symlinksSupported) {
        yield* fileSystem.symlink(base, path.join(root, "alias"));
        assert.strictEqual(yield* serverDeclarerId(path.join(root, "alias")), id);
      }
      assert.notStrictEqual(yield* serverDeclarerId(root), id);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

describe("makeHomeProvisionerRunner", () => {
  const gatedApply = Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const started = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const finished = yield* Ref.make(0);
    const apply = (next: ProvisionerRequest) =>
      Effect.gen(function* () {
        const label =
          next.declaration.homes[0]?.home.agent === "claude"
            ? next.declaration.homes[0].home.configDir
            : "";
        yield* Ref.update(calls, (all) => [...all, label]);
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(gate);
        yield* Ref.update(finished, (count) => count + 1);
        return { kind: "applied", output: label } satisfies ProvisionerOutcome;
      });
    return { calls, started, gate, finished, apply };
  });

  it.effect("merges requests made during a run into one trailing run with the newest", () =>
    Effect.gen(function* () {
      const fake = yield* gatedApply;
      const runner = yield* makeHomeProvisionerRunner(fake.apply);
      const first = yield* Effect.forkChild(runner.request(request("a")));
      yield* Deferred.await(fake.started);
      const second = yield* Effect.forkChild(runner.request(request("b")));
      const third = yield* Effect.forkChild(runner.request(request("c")));
      // Past the cap every request has joined the runner, so the order below is fixed.
      yield* TestClock.adjust("5 seconds");
      for (const waiting of [first, second, third]) {
        assert.deepStrictEqual(yield* Fiber.join(waiting), { kind: "stillRunning" });
      }
      yield* Deferred.succeed(fake.gate, undefined);
      const after: ProvisionerWait = yield* runner.request(request("d"));
      assert.deepStrictEqual(after, {
        kind: "finished",
        outcome: { kind: "applied", output: "d" },
      });
      assert.deepStrictEqual(yield* Ref.get(fake.calls), ["a", "c", "d"]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops waiting after the cap and lets the run finish", () =>
    Effect.gen(function* () {
      const fake = yield* gatedApply;
      const runner = yield* makeHomeProvisionerRunner(fake.apply);
      const waiting = yield* Effect.forkChild(runner.request(request("slow")));
      yield* Deferred.await(fake.started);
      yield* TestClock.adjust("5 seconds");
      assert.deepStrictEqual(yield* Fiber.join(waiting), { kind: "stillRunning" });
      assert.strictEqual(yield* Ref.get(fake.finished), 0);

      const next = yield* Effect.forkChild(runner.request(request("next")));
      yield* Deferred.succeed(fake.gate, undefined);
      assert.deepStrictEqual(yield* Fiber.join(next), {
        kind: "finished",
        outcome: { kind: "applied", output: "next" },
      });
      assert.strictEqual(yield* Ref.get(fake.finished), 2);
      assert.deepStrictEqual(yield* Ref.get(fake.calls), ["slow", "next"]);
    }).pipe(Effect.scoped),
  );

  it.effect("turns a run that dies into a failed outcome and keeps taking requests", () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make(0);
      const runner = yield* makeHomeProvisionerRunner((next) =>
        Ref.getAndUpdate(runs, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 0
              ? Effect.die(new Error("provisioner defect"))
              : Effect.succeed<ProvisionerOutcome>({
                  kind: "applied",
                  output: next.declaration.declarer,
                }),
          ),
        ),
      );
      const died = yield* runner.request(request("a"));
      assert.strictEqual(died.kind === "finished" ? died.outcome.kind : died.kind, "failed");
      assert.include(
        died.kind === "finished" && died.outcome.kind === "failed" ? died.outcome.detail : "",
        "provisioner defect",
      );
      assert.deepStrictEqual(yield* runner.request(request("b")), {
        kind: "finished",
        outcome: { kind: "applied", output: "t3code:test" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("frees the runner and ends every wait when its worker is interrupted", () =>
    Effect.gen(function* () {
      const fake = yield* gatedApply;
      const runnerScope = yield* Scope.make();
      const runner = yield* makeHomeProvisionerRunner(fake.apply).pipe(Scope.provide(runnerScope));
      const first = yield* Effect.forkChild(runner.request(request("a")));
      yield* Deferred.await(fake.started);
      const second = yield* Effect.forkChild(runner.request(request("b")));
      yield* Effect.yieldNow;
      yield* Scope.close(runnerScope, Exit.void);
      for (const waiting of [first, second]) {
        assert.deepStrictEqual(yield* Fiber.join(waiting), {
          kind: "finished",
          outcome: { kind: "failed", detail: "was stopped." },
        });
      }
    }),
  );
});

describe("spawnHomeProvisioner", () => {
  it.effect("writes the declaration to the command's stdin and reports its exit", () =>
    Effect.gen(function* () {
      const echo = yield* spawnHomeProvisioner({
        command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
        declaration: request("/x").declaration,
      });
      assert.strictEqual(echo.kind, "applied");
      assert.deepStrictEqual(
        JSON.parse(echo.kind === "applied" ? echo.output : "null") as HomeDeclarationWireV1,
        request("/x").declaration,
      );
      const failed = yield* spawnHomeProvisioner({
        command: [process.execPath, "-e", "console.error('no such declarer'); process.exit(3)"],
        declaration: request("/x").declaration,
      });
      assert.deepStrictEqual(failed, { kind: "failed", detail: "exited with 3: no such declarer" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps only the first 16 KiB of a command's output", () =>
    Effect.gen(function* () {
      const loud = yield* spawnHomeProvisioner({
        command: [process.execPath, "-e", "process.stdout.write('x'.repeat(1 << 20))"],
        declaration: request("/x").declaration,
      });
      assert.strictEqual(loud.kind === "applied" ? loud.output.length : 0, 16 * 1024);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("end-to-end home declaration delivery", () => {
  it.live.skipIf(!symlinksSupported)(
    "materializes Codex overlays and delivers Claude, Codex, and Antigravity homes to a stub provisioner",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-provision-" });
        const osHome = path.join(root, "home");
        const claudeHome = path.join(root, "slots", "claude-work");
        const codexBase = path.join(root, "codex-base");
        const overlayFresh = path.join(root, "overlays", "fresh");
        const overlayOld = path.join(root, "overlays", "old");
        const stateDir = path.join(root, "userdata");
        const recordedPath = path.join(root, "received-declaration.json");
        for (const directory of [osHome, claudeHome, codexBase, stateDir]) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
        }
        yield* fileSystem.writeFileString(path.join(codexBase, "config.toml"), "");
        yield* fileSystem.writeFileString(path.join(codexBase, "hooks.json"), "{}\n");
        yield* fileSystem.makeDirectory(path.join(codexBase, "app-server-control"));
        yield* fileSystem.makeDirectory(overlayOld, { recursive: true });
        yield* fileSystem.writeFileString(path.join(overlayOld, "auth.json"), "{}\n");
        yield* fileSystem.symlink(
          path.join(codexBase, "app-server-control"),
          path.join(overlayOld, "app-server-control"),
        );
        for (const overlay of [overlayFresh, overlayOld]) {
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: codexBase, shadowHomePath: overlay }),
          );
          yield* materializeCodexShadowHome(layout);
          assert.strictEqual(
            yield* fileSystem.readLink(path.join(overlay, "hooks.json")),
            path.join(codexBase, "hooks.json"),
          );
          assert.isFalse(
            yield* fileSystem.readLink(path.join(overlay, "app-server-control")).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ),
          );
        }

        const settings = settingsWith({
          claudeAgent: { driver: claude, enabled: false },
          codex: { driver: codex, enabled: false },
          claude_work: { driver: claude, config: { homePath: claudeHome } },
          codex_fresh: {
            driver: codex,
            config: { homePath: codexBase, shadowHomePath: overlayFresh },
          },
          codex_old: { driver: codex, config: { homePath: codexBase, shadowHomePath: overlayOld } },
          agy: { driver: antigravity, enabled: true },
        });
        const derived = yield* deriveDeclaredHomes(deriveProviderInstanceConfigMap(settings), {
          stateDir,
        }).pipe(
          Effect.provideService(HostProcess.HomeDirectory, osHome),
          Effect.provideService(HostProcess.Environment, {}),
        );

        const stubScript = [
          "const fs = require('node:fs');",
          "let data = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { data += chunk; });",
          "process.stdin.on('end', () => {",
          "  const parsed = JSON.parse(data);",
          "  if (parsed.version !== 1 || !Array.isArray(parsed.homes)) process.exit(2);",
          "  fs.writeFileSync(process.argv[1], JSON.stringify(parsed));",
          "});",
        ].join("\n");
        const declarer = yield* serverDeclarerId(stateDir);
        const outcome = yield* spawnHomeProvisioner({
          command: [process.execPath, "-e", stubScript, recordedPath],
          declaration: {
            version: 1,
            declarer,
            homes: derived.homes.map((home) => ({ home })),
          },
        });
        assert.strictEqual(outcome.kind, "applied", JSON.stringify(outcome));

        const received = JSON.parse(
          yield* fileSystem.readFileString(recordedPath),
        ) as HomeDeclarationWireV1;
        assert.strictEqual(received.version, 1);
        assert.strictEqual(received.declarer, declarer);
        assert.deepStrictEqual(
          received.homes.map((entry) => entry.home),
          derived.homes,
        );
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
