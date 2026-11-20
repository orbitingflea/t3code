import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { BUILT_IN_DRIVERS } from "../../provider/builtInDrivers.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  BUILT_IN_DRIVER_KINDS,
  ProviderPoolPlacementError,
  ProviderPoolUnresolvedError,
  providerSupportsModel,
  refreshRequestedInstances,
  resolveCommandPool,
  resolvePoolTarget,
  wrapOrchestratorDispatch,
} from "./poolPlacement.ts";

const id = ProviderInstanceId.make;
const claude = ProviderDriverKind.make("claudeAgent");
const antigravity = ProviderDriverKind.make("antigravity");
const projectId = ProjectId.make("project:pools");
const projectWithMembersOff = ProjectId.make("project:pools-off");
const threadId = ThreadId.make("thread:pools");
const NOW = "2026-11-20T12:00:00.000Z";

const settingsLayer = ServerSettings.ServerSettingsService.layerTest({
  providerInstances: {
    [id("claude_a")]: { driver: claude },
    [id("claude_b")]: { driver: claude },
    [id("codex_a")]: { driver: ProviderDriverKind.make("codex") },
    [id("agy_a")]: { driver: antigravity, enabled: true },
    [id("agy_b")]: { driver: antigravity, enabled: true },
  },
  providerPools: {
    claude_auto: { displayName: "Claude Auto", members: ["claude_a", "claude_b"] },
    agy_auto: { displayName: "Antigravity Auto", members: ["agy_a", "agy_b"] },
    broken: { members: ["claude_a", "codex_a"] },
    codex_a: { members: ["claude_a"] },
    codex: { members: ["mixed", 1] },
  },
  projectSettingsOverrides: {
    [projectWithMembersOff]: {
      providerInstances: {
        [id("claude_a")]: { enabled: false },
        [id("claude_b")]: { enabled: false },
      },
    },
  },
});

const unreadableSettings = Effect.fail(
  new ServerSettingsError({ settingsPath: "settings.json", operation: "normalize" }),
);

const provider = (instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: id(instanceId),
  driver: claude,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [{ slug: "opus", name: "Opus", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const fullUntil = (resetsAt: string): Partial<ServerProvider> => ({
  usageLimits: {
    checkedAt: NOW,
    windows: [{ id: "week", kind: "weekly", label: "Week", usedPercent: 100, resetsAt }],
  },
});

const atNow = TestClock.setTime(Date.parse(NOW));

const getSettings = Effect.gen(function* () {
  return yield* (yield* ServerSettings.ServerSettingsService).getSettings;
});

const launchFrom = (
  requested: string,
  providers: ReadonlyArray<ServerProvider>,
  seedKey = "command:launch",
) =>
  resolvePoolTarget({
    requestedInstanceId: id(requested),
    projectId,
    model: "opus",
    seedKey,
    getSettings,
    providers: Effect.succeed(providers),
  });

const switchCommand = (instanceId: string): OrchestrationV2ServerCommand => ({
  type: "provider.switch",
  commandId: CommandId.make("command:switch"),
  threadId,
  modelSelection: { instanceId: id(instanceId), model: "opus" },
});

const orchestratorWith = (current: string | null) => ({
  getSettings,
  threadShell: () =>
    Effect.succeed(current === null ? null : { projectId, providerInstanceId: id(current) }),
  registeredInstanceIds: Effect.succeed([id("claude_a"), id("claude_b"), id("codex_a")]),
  hasReceipt: () => Effect.succeed(false),
});

const createCommand = (instanceId: string): OrchestrationV2ServerCommand => ({
  type: "thread.create",
  createdBy: "user",
  creationSource: "web",
  commandId: CommandId.make("command:create"),
  threadId,
  projectId,
  title: "Pooled",
  modelSelection: { instanceId: id(instanceId), model: "opus" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
});

it.layer(settingsLayer)("provider pool placement", (it) => {
  describe("launch and delegate targets", () => {
    it.effect("passes a concrete instance through without loading providers", () =>
      Effect.gen(function* () {
        const placed = yield* resolvePoolTarget({
          requestedInstanceId: id("claude_b"),
          projectId,
          seedKey: "command:x",
          getSettings,
          providers: Effect.die("providers are not needed for a concrete instance"),
        });
        assert.strictEqual(placed, "claude_b");
      }),
    );

    it.effect("places a pool on one member, the same one on retry", () =>
      Effect.gen(function* () {
        yield* atNow;
        const providers = [provider("claude_a"), provider("claude_b")];
        const first = yield* launchFrom("claude_auto", providers);
        assert.include(["claude_a", "claude_b"], first);
        assert.strictEqual(yield* launchFrom("claude_auto", providers), first);
      }),
    );

    it.effect("skips a member that is signed out or at its usage limit", () =>
      Effect.gen(function* () {
        yield* atNow;
        const later = "2026-11-21T00:00:00.000Z";
        for (const seedKey of ["k1", "k2", "k3"]) {
          assert.strictEqual(
            yield* launchFrom(
              "claude_auto",
              [provider("claude_a", fullUntil(later)), provider("claude_b")],
              seedKey,
            ),
            "claude_b",
          );
          assert.strictEqual(
            yield* launchFrom(
              "claude_auto",
              [provider("claude_a"), provider("claude_b", { auth: { status: "unauthenticated" } })],
              seedKey,
            ),
            "claude_a",
          );
        }
      }),
    );

    it.effect("fails with each member's reason when no member can run", () =>
      Effect.gen(function* () {
        yield* atNow;
        const error = yield* launchFrom("claude_auto", [
          provider("claude_a", { enabled: false }),
        ]).pipe(Effect.flip);
        assert.instanceOf(error, ProviderPoolPlacementError);
        assert.deepStrictEqual(error.reasons, [
          "claude_a: is turned off.",
          "claude_b: is not registered.",
        ]);
      }),
    );

    it.effect("fails a delegate whose driver or own check rules out the pool", () =>
      Effect.gen(function* () {
        yield* atNow;
        const providers = [provider("claude_a"), provider("claude_b")];
        const wrongDriver = yield* resolvePoolTarget({
          requestedInstanceId: id("claude_auto"),
          projectId,
          driver: ProviderDriverKind.make("codex"),
          seedKey: "command:delegate",
          getSettings,
          providers: Effect.succeed(providers),
        }).pipe(Effect.flip);
        assert.include(wrongDriver.message, "runs claudeAgent, not codex.");

        const placed = yield* resolvePoolTarget({
          requestedInstanceId: id("claude_auto"),
          projectId,
          seedKey: "command:delegate",
          getSettings,
          providers: Effect.succeed(providers),
          unusableReason: (candidate) =>
            candidate.instanceId === "claude_a" ? "has no V2 adapter." : null,
        });
        assert.strictEqual(placed, "claude_b");
      }),
    );

    it.effect("fails an invalid pool with the reason it was dropped", () =>
      Effect.gen(function* () {
        const error = yield* launchFrom("broken", [provider("claude_a")]).pipe(Effect.flip);
        assert.deepStrictEqual(error.reasons, [
          "Provider pool 'broken' mixes members of different drivers.",
        ]);
      }),
    );

    it.effect("sends an id shared by an instance and an invalid pool to the instance", () =>
      Effect.gen(function* () {
        for (const requested of ["codex_a", "codex"]) {
          const placed = yield* resolvePoolTarget({
            requestedInstanceId: id(requested),
            projectId,
            seedKey: "command:collide",
            getSettings,
            providers: Effect.die("providers are not needed for a concrete instance"),
          });
          assert.strictEqual(placed, requested);
        }
      }),
    );

    it.effect("ignores the project's enabled instances on a receipt replay", () =>
      Effect.gen(function* () {
        yield* atNow;
        const providers = [provider("claude_a"), provider("claude_b")];
        const replay = (skipProjectEnablementFilter: boolean) =>
          resolvePoolTarget({
            requestedInstanceId: id("claude_auto"),
            projectId: projectWithMembersOff,
            seedKey: "command:replay",
            getSettings,
            providers: Effect.succeed(providers),
            skipProjectEnablementFilter,
          });
        const refused = yield* replay(false).pipe(Effect.flip);
        assert.deepStrictEqual(refused.reasons, [
          "claude_a: is turned off for this project.",
          "claude_b: is turned off for this project.",
        ]);
        assert.include(["claude_a", "claude_b"], yield* replay(true));
      }),
    );

    it.effect("reuses the instance a retried launch committed without placing again", () =>
      Effect.gen(function* () {
        const placed = yield* resolvePoolTarget({
          requestedInstanceId: id("claude_auto"),
          projectId,
          seedKey: "command:retry",
          getSettings,
          providers: Effect.die("a committed retry does not place"),
          committedInstanceId: Effect.succeed(id("claude_b")),
        });
        assert.strictEqual(placed, "claude_b");
      }),
    );

    it.effect("re-probes every member of a pool, or the one instance named", () =>
      Effect.gen(function* () {
        const probed: Array<string> = [];
        const refresh = (requested: string) =>
          refreshRequestedInstances({
            requestedInstanceId: id(requested),
            getSettings,
            refreshInstance: (instanceId) =>
              Effect.sync(() => {
                probed.push(instanceId);
                return [provider(instanceId)];
              }),
          });
        yield* refresh("claude_auto");
        yield* refresh("codex_a");
        assert.deepStrictEqual(probed, ["claude_a", "claude_b", "codex_a"]);
      }),
    );
  });

  describe("orchestrator commands", () => {
    it.effect("keeps the thread's instance on a switch to its own pool", () =>
      Effect.gen(function* () {
        const resolved = yield* resolveCommandPool(
          switchCommand("claude_auto"),
          orchestratorWith("claude_b"),
        );
        assert.deepStrictEqual(resolved, switchCommand("claude_b"));
      }),
    );

    it.effect("places a switch from another driver on a member", () =>
      Effect.gen(function* () {
        const resolved = yield* resolveCommandPool(
          switchCommand("claude_auto"),
          orchestratorWith("codex_a"),
        );
        assert.strictEqual(resolved.type, "provider.switch");
        const instanceId =
          resolved.type === "provider.switch" ? resolved.modelSelection.instanceId : "";
        assert.include(["claude_a", "claude_b"], instanceId);
      }),
    );

    it.effect("leaves concrete selections and commands without one alone", () =>
      Effect.gen(function* () {
        const concrete = switchCommand("codex_a");
        assert.strictEqual(
          yield* resolveCommandPool(concrete, orchestratorWith("claude_a")),
          concrete,
        );
        const stop: OrchestrationV2ServerCommand = {
          type: "thread.stop",
          commandId: CommandId.make("command:stop"),
          threadId,
        };
        assert.strictEqual(yield* resolveCommandPool(stop, orchestratorWith(null)), stop);
      }),
    );

    it.effect("refuses a thread create that still names a pool", () =>
      Effect.gen(function* () {
        const error = yield* resolveCommandPool(
          createCommand("claude_auto"),
          orchestratorWith(null),
        ).pipe(Effect.flip);
        assert.instanceOf(error, ProviderPoolUnresolvedError);
        const concrete = createCommand("claude_a");
        assert.strictEqual(yield* resolveCommandPool(concrete, orchestratorWith(null)), concrete);
      }),
    );

    it.effect("keeps a concrete instance whose id an invalid pool shares", () =>
      Effect.gen(function* () {
        for (const command of [switchCommand("codex_a"), createCommand("codex")]) {
          assert.strictEqual(
            yield* resolveCommandPool(command, orchestratorWith("claude_a")),
            command,
          );
        }
      }),
    );

    it.effect("passes only a registered instance when settings cannot be read", () =>
      Effect.gen(function* () {
        const orchestrator = { ...orchestratorWith(null), getSettings: unreadableSettings };
        const registered = createCommand("claude_a");
        assert.strictEqual(yield* resolveCommandPool(registered, orchestrator), registered);
        const error = yield* resolveCommandPool(createCommand("claude_auto"), orchestrator).pipe(
          Effect.flip,
        );
        assert.instanceOf(error, ServerSettingsError);
      }),
    );

    it.effect("replays an accepted switch without placing it again", () =>
      Effect.gen(function* () {
        const command = switchCommand("claude_auto");
        const replayed = yield* resolveCommandPool(command, {
          ...orchestratorWith("codex_a"),
          registeredInstanceIds: Effect.succeed([]),
          hasReceipt: () => Effect.succeed(true),
        });
        assert.strictEqual(replayed, command);
      }),
    );

    it.effect(
      "uses provider snapshots to skip signed-out, incompatible, and limited members on switch",
      () =>
        Effect.gen(function* () {
          yield* atNow;
          const signedOutCurrent = yield* resolveCommandPool(switchCommand("claude_auto"), {
            ...orchestratorWith("claude_a"),
            providers: Effect.succeed([
              provider("claude_a", { auth: { status: "unauthenticated" } }),
              provider("claude_b"),
            ]),
          });
          assert.strictEqual(
            signedOutCurrent.type === "provider.switch"
              ? signedOutCurrent.modelSelection.instanceId
              : "",
            "claude_b",
          );

          const limitedAndWrongModel = yield* resolveCommandPool(switchCommand("claude_auto"), {
            ...orchestratorWith("codex_a"),
            providers: Effect.succeed([
              provider("claude_a", fullUntil("2026-11-20T15:00:00.000Z")),
              provider("claude_b"),
            ]),
          });
          assert.strictEqual(
            limitedAndWrongModel.type === "provider.switch"
              ? limitedAndWrongModel.modelSelection.instanceId
              : "",
            "claude_b",
          );

          const missingModel = yield* resolveCommandPool(switchCommand("claude_auto"), {
            ...orchestratorWith("claude_a"),
            providers: Effect.succeed([
              provider("claude_a", {
                models: [{ slug: "sonnet", name: "Sonnet", isCustom: false, capabilities: null }],
              }),
              provider("claude_b"),
            ]),
          });
          assert.strictEqual(
            missingModel.type === "provider.switch" ? missingModel.modelSelection.instanceId : "",
            "claude_b",
          );
        }),
    );

    it.effect("wrapOrchestratorDispatch reads ProviderRegistry snapshots from context", () =>
      Effect.gen(function* () {
        const received: Array<OrchestrationV2ServerCommand> = [];
        const serverSettings = yield* ServerSettings.ServerSettingsService;
        const dispatch = yield* wrapOrchestratorDispatch(
          (command) =>
            Effect.sync(() => {
              received.push(command);
              return command;
            }),
          {
            serverSettings,
            projectionStore: {
              getThreadShell: () =>
                Effect.succeed({ projectId, providerInstanceId: id("claude_a") }),
            },
            providerAdapters: {
              list: () => Effect.succeed([id("claude_a"), id("claude_b")]),
            },
            commandReceipts: {
              getByCommandId: () => Effect.succeedNone,
            },
            mapError: (_command, cause) => cause,
          },
        );
        yield* dispatch(switchCommand("claude_auto"));
        assert.strictEqual(received.length, 1);
        const placed = received[0]!;
        assert.strictEqual(
          placed.type === "provider.switch" ? placed.modelSelection.instanceId : "",
          "claude_b",
        );
      }).pipe(
        Effect.provide(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              provider("claude_a", { auth: { status: "unauthenticated" } }),
              provider("claude_b"),
            ]),
          }),
        ),
      ),
    );
  });

  describe("model matching semantics", () => {
    it.effect("accepts aliases, Antigravity thinking suffixes, and empty model catalogs", () =>
      Effect.gen(function* () {
        yield* atNow;
        const aliasedProvider = provider("claude_a", {
          models: [
            {
              slug: "opus",
              name: "Opus",
              aliases: ["claude-opus"],
              isCustom: false,
              capabilities: null,
            },
          ],
          usageLimits: {
            checkedAt: NOW,
            windows: [
              {
                id: "week",
                kind: "weekly",
                label: "Week",
                usedPercent: 100,
                resetsAt: "2026-11-20T15:00:00.000Z",
                modelIds: ["opus"],
              },
            ],
          },
        });
        const emptyCatalogProvider = provider("claude_b", { models: [] });

        assert.isTrue(providerSupportsModel(aliasedProvider, "CLAUDE-OPUS"));
        assert.isTrue(providerSupportsModel(emptyCatalogProvider, "any-custom-slug"));
        assert.isFalse(providerSupportsModel(aliasedProvider, "unknown-model"));

        const aliasPlacement = yield* resolvePoolTarget({
          requestedInstanceId: id("claude_auto"),
          projectId,
          model: "CLAUDE-OPUS",
          seedKey: "command:alias",
          getSettings,
          providers: Effect.succeed([aliasedProvider, emptyCatalogProvider]),
        });
        assert.strictEqual(aliasPlacement, id("claude_b"));

        const agyWithThinking = provider("agy_a", {
          driver: antigravity,
          models: [
            {
              slug: "gemini-3.8-flash",
              name: "Gemini 3.8 Flash",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "thought_level",
                    label: "Thinking",
                    type: "select",
                    role: "reasoning",
                    options: [
                      { id: "low", label: "Low" },
                      { id: "high", label: "High" },
                    ],
                  },
                ],
              },
            },
          ],
        });
        const agyWithout = provider("agy_b", {
          driver: antigravity,
          models: [{ slug: "other", name: "Other", isCustom: false, capabilities: null }],
        });

        assert.isTrue(providerSupportsModel(agyWithThinking, "gemini-3.8-flash-high"));
        assert.isFalse(providerSupportsModel(agyWithThinking, "gemini-3.8-flash-bogus"));

        const agyPlacement = yield* resolvePoolTarget({
          requestedInstanceId: id("agy_auto"),
          projectId,
          model: "gemini-3.8-flash-high",
          seedKey: "command:agy",
          getSettings,
          providers: Effect.succeed([agyWithThinking, agyWithout]),
        });
        assert.strictEqual(agyPlacement, id("agy_a"));
      }),
    );
  });

  it("lists the same driver kinds as the built-in drivers", () => {
    assert.deepStrictEqual(
      [...BUILT_IN_DRIVER_KINDS].toSorted(),
      BUILT_IN_DRIVERS.map((driver) => driver.driverKind as string).toSorted(),
    );
  });
});
