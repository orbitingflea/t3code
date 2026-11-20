import {
  isProviderAvailable,
  type CommandId,
  resolveProjectProviderInstanceEnabled,
  type OrchestrationV2ServerCommand,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import {
  buildPoolTable,
  resolvePoolSelection,
  type PoolCandidate,
  type PoolTable,
} from "./pools.ts";

/** Pool ids may not take these, since each also names a driver's default instance. */
export const BUILT_IN_DRIVER_KINDS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "fx",
  "opencode",
  "antigravity",
  "kiro",
  "pi",
  "muse",
  "acpRegistry",
]);

export class ProviderPoolPlacementError extends Schema.TaggedError<ProviderPoolPlacementError>()(
  "ProviderPoolPlacementError",
  { poolId: Schema.String, reasons: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `No member of provider pool '${this.poolId}' can take this request. ${this.reasons.join(" ")}`;
  }
}

export class ProviderPoolUnresolvedError extends Schema.TaggedError<ProviderPoolUnresolvedError>()(
  "ProviderPoolUnresolvedError",
  { poolId: Schema.String, commandType: Schema.String },
) {
  override get message(): string {
    return `Provider pool '${this.poolId}' reached ${this.commandType} without being placed on one of its instances.`;
  }
}

const advertisedModel = (provider: ServerProvider, model: string) =>
  provider.models.find((candidate) => candidate.slug === model) ??
  provider.models.find((candidate) =>
    candidate.aliases?.some((alias) => alias.toLowerCase() === model.toLowerCase()),
  );

const antigravityBaseModelSlug = (provider: ServerProvider, model: string): string | undefined => {
  if (provider.driver !== "antigravity" || advertisedModel(provider, model)) return undefined;
  const separator = model.lastIndexOf("-");
  if (separator === -1) return undefined;
  const family = model.slice(0, separator);
  const value = model.slice(separator + 1);
  const thinking = provider.models
    .find((candidate) => candidate.slug === family)
    ?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.type === "select" && descriptor.role === "reasoning",
    );
  if (thinking?.type === "select" && thinking.options.some((choice) => choice.id === value)) {
    return family;
  }
  return undefined;
};

/** Accepts exact slugs, case-insensitive aliases, Antigravity thinking suffixes, and empty catalogs. */
export const providerSupportsModel = (provider: ServerProvider, model: string): boolean =>
  provider.models.length === 0 ||
  advertisedModel(provider, model) !== undefined ||
  antigravityBaseModelSlug(provider, model) !== undefined;

/** The latest reset among full usage windows that cover the model, or null when none is full. */
const providerLimitedUntil = (
  provider: ServerProvider,
  model: string | undefined,
): number | null => {
  const canonicalModel =
    model === undefined
      ? undefined
      : (advertisedModel(provider, model)?.slug ?? antigravityBaseModelSlug(provider, model));
  let until: number | null = null;
  for (const window of provider.usageLimits?.windows ?? []) {
    if (window.usedPercent < 100 || window.resetsAt === undefined) continue;
    if (
      model !== undefined &&
      window.modelIds !== undefined &&
      !window.modelIds.includes(model) &&
      (canonicalModel === undefined || !window.modelIds.includes(canonicalModel))
    ) {
      continue;
    }
    const resetsAt = Date.parse(window.resetsAt);
    if (Number.isFinite(resetsAt) && (until === null || resetsAt > until)) until = resetsAt;
  }
  return until;
};

const providerUnusableReason = (provider: ServerProvider): string | null => {
  if (!isProviderAvailable(provider)) {
    return provider.unavailableReason ?? "is unavailable.";
  }
  if (!provider.enabled) return "is turned off.";
  if (!provider.installed) return "is not installed.";
  if (provider.status === "error" || provider.status === "disabled") {
    return provider.message ?? `has status ${provider.status}.`;
  }
  if (provider.auth.status === "unauthenticated") return "is not signed in.";
  return null;
};

const candidatesFromProviders = (input: {
  readonly settings: ServerSettings;
  readonly projectId: ProjectId | null;
  readonly model: string | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly unusableReason: (provider: ServerProvider) => string | null;
  readonly skipProjectEnablementFilter: boolean;
}): ReadonlyArray<PoolCandidate> =>
  input.providers.map((provider) => ({
    instanceId: provider.instanceId,
    unusableReason: input.unusableReason(provider),
    enabledForProject:
      input.skipProjectEnablementFilter ||
      resolveProjectProviderInstanceEnabled(input.settings, input.projectId, provider.instanceId),
    supportsModel: (requested) => providerSupportsModel(provider, requested),
    limitedUntil: providerLimitedUntil(provider, input.model),
  }));

type GetSettings<R> = Effect.Effect<ServerSettings, ServerSettingsError, R>;

const poolTable = (settings: ServerSettings): PoolTable =>
  buildPoolTable(settings, BUILT_IN_DRIVER_KINDS);

/** Unreadable settings name no pools, so a settings fault never blocks an instance selection. */
const readPools = <R>(getSettings: GetSettings<R>) =>
  getSettings.pipe(
    Effect.map((settings) => ({ settings, table: poolTable(settings) })),
    Effect.orElseSucceed(() => undefined),
  );

/** A valid or dropped pool. An instance id never names a pool, even when a pool entry shares it. */
const namesPool = (table: PoolTable, instanceId: ProviderInstanceId): boolean =>
  table.pools.has(instanceId) || table.dropped.has(instanceId);

const placeInPool = Effect.fn("providerPools.placeInPool")(function* (input: {
  readonly table: PoolTable;
  readonly kind: "launch" | "switch";
  readonly requestedInstanceId: ProviderInstanceId;
  readonly currentInstanceId: ProviderInstanceId | null;
  readonly driver: ProviderDriverKind | undefined;
  readonly model: string | undefined;
  readonly seedKey: string;
  readonly candidates: ReadonlyArray<PoolCandidate>;
}) {
  const { table } = input;
  const dropped = table.dropped.get(input.requestedInstanceId);
  if (dropped !== undefined) {
    return yield* new ProviderPoolPlacementError({
      poolId: input.requestedInstanceId,
      reasons: [dropped],
    });
  }
  const base = {
    requestedInstanceId: input.requestedInstanceId,
    driver: input.driver,
    model: input.model,
    seedKey: input.seedKey,
    table,
    candidates: input.candidates,
    now: yield* Clock.currentTimeMillis,
  };
  const selection = resolvePoolSelection(
    input.kind === "launch"
      ? { ...base, kind: "launch" }
      : { ...base, kind: "switch", currentInstanceId: input.currentInstanceId },
  );
  if (selection.kind === "noEligibleMember") {
    return yield* new ProviderPoolPlacementError({
      poolId: selection.poolId,
      reasons: selection.reasons,
    });
  }
  yield* Effect.logInfo("Provider pool placed a request", {
    poolId: input.requestedInstanceId,
    instanceId: selection.instanceId,
    kind: selection.kind,
    seedKey: input.seedKey,
  });
  return selection.instanceId;
});

/**
 * Where a new thread or child task starts from a requested selection: an instance id passes
 * through, a pool id becomes one of its members. Providers load only when a pool is named.
 */
export const resolvePoolTarget = Effect.fn("providerPools.resolvePoolTarget")(function* <R>(input: {
  readonly requestedInstanceId: ProviderInstanceId;
  readonly projectId: ProjectId | null;
  readonly driver?: ProviderDriverKind | undefined;
  readonly model?: string | undefined;
  readonly seedKey: string;
  readonly getSettings: GetSettings<R>;
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly unusableReason?: ((provider: ServerProvider) => string | null) | undefined;
  /** A receipt replay starts no work, so it ignores the project's enabled instances. */
  readonly skipProjectEnablementFilter?: boolean | undefined;
  /** On a retry of an accepted command, the instance its first try committed, which skips placement. */
  readonly committedInstanceId?: Effect.Effect<ProviderInstanceId | null> | undefined;
}) {
  const pools = yield* readPools(input.getSettings);
  if (pools === undefined || !namesPool(pools.table, input.requestedInstanceId)) {
    return input.requestedInstanceId;
  }
  const committed =
    input.committedInstanceId === undefined ? null : yield* input.committedInstanceId;
  if (committed !== null) return committed;
  const { settings, table } = pools;
  return yield* placeInPool({
    table,
    kind: "launch",
    requestedInstanceId: input.requestedInstanceId,
    currentInstanceId: null,
    driver: input.driver,
    model: input.model,
    seedKey: input.seedKey,
    candidates: candidatesFromProviders({
      settings,
      projectId: input.projectId,
      model: input.model,
      providers: yield* input.providers,
      unusableReason: input.unusableReason ?? providerUnusableReason,
      skipProjectEnablementFilter: input.skipProjectEnablementFilter === true,
    }),
  });
});

/** Re-probes the requested instance, or each member when the id names a pool. */
export const refreshRequestedInstances = Effect.fn("providerPools.refreshRequestedInstances")(
  function* <R>(input: {
    readonly requestedInstanceId: ProviderInstanceId;
    readonly getSettings: GetSettings<R>;
    readonly refreshInstance: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  }) {
    const pools = yield* readPools(input.getSettings);
    const instanceIds = pools?.table.pools.get(input.requestedInstanceId)?.members ?? [
      input.requestedInstanceId,
    ];
    const snapshots = yield* Effect.forEach(instanceIds, input.refreshInstance);
    return snapshots.at(-1) ?? [];
  },
);

type SwitchCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "provider.switch" | "thread.model-selection.set" | "message.dispatch" }
>;
type CreateCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.create" | "delegated_task.request" }
>;

const isSwitchCommand = (command: OrchestrationV2ServerCommand): command is SwitchCommand =>
  command.type === "provider.switch" ||
  command.type === "thread.model-selection.set" ||
  command.type === "message.dispatch";

const isCreateCommand = (command: OrchestrationV2ServerCommand): command is CreateCommand =>
  command.type === "thread.create" || command.type === "delegated_task.request";

const commandSelection = (command: OrchestrationV2ServerCommand) =>
  isCreateCommand(command) || isSwitchCommand(command) ? command.modelSelection : undefined;

/**
 * Whether a command's own selection names a pool. Thread management skips its project check for
 * one: the orchestrator places a pool only on a member enabled for the project.
 */
export const commandNamesPool = <R>(
  command: OrchestrationV2ServerCommand,
  getSettings: GetSettings<R>,
) => {
  const selection = commandSelection(command);
  return selection === undefined
    ? Effect.succeed(false)
    : readPools(getSettings).pipe(
        Effect.map((pools) => pools !== undefined && namesPool(pools.table, selection.instanceId)),
      );
};

/**
 * The orchestrator's last check before a selection is persisted. A switch to a pool is placed
 * here, keeping the thread's instance when it is an eligible member. A create that still names a
 * pool is refused, because its caller had to place it first. When settings cannot be read, only
 * a registered instance passes, so a pool id is never persisted.
 */
export const resolveCommandPool = Effect.fn("providerPools.resolveCommandPool")(function* <R>(
  command: OrchestrationV2ServerCommand,
  orchestrator: {
    readonly getSettings: GetSettings<R>;
    readonly threadShell: (threadId: ThreadId) => Effect.Effect<{
      readonly projectId: ProjectId;
      readonly providerInstanceId: ProviderInstanceId;
    } | null>;
    readonly registeredInstanceIds: Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
    readonly providers?: Effect.Effect<ReadonlyArray<ServerProvider>> | undefined;
    readonly hasReceipt: (commandId: CommandId) => Effect.Effect<boolean>;
  },
) {
  const selection = commandSelection(command);
  if (selection === undefined) return command;
  const settings = yield* orchestrator.getSettings.pipe(
    Effect.catch((error) =>
      orchestrator.registeredInstanceIds.pipe(
        Effect.flatMap((registered) =>
          registered.includes(selection.instanceId) ? Effect.undefined : Effect.fail(error),
        ),
      ),
    ),
  );
  if (settings === undefined) return command;
  const table = poolTable(settings);
  if (!namesPool(table, selection.instanceId)) return command;
  if (!isSwitchCommand(command)) {
    return yield* new ProviderPoolUnresolvedError({
      poolId: selection.instanceId,
      commandType: command.type,
    });
  }
  // A retry of an accepted command replays its first result, so it is not placed again.
  if (yield* orchestrator.hasReceipt(command.commandId)) return command;
  const shell = yield* orchestrator.threadShell(command.threadId);
  const registered = yield* orchestrator.registeredInstanceIds;
  const candidates =
    orchestrator.providers !== undefined
      ? candidatesFromProviders({
          settings,
          projectId: shell?.projectId ?? null,
          model: selection.model,
          providers: (yield* orchestrator.providers).filter((provider) =>
            registered.includes(provider.instanceId),
          ),
          unusableReason: providerUnusableReason,
          skipProjectEnablementFilter: false,
        })
      : registered.map((registeredId) => ({
          instanceId: registeredId,
          unusableReason: null,
          enabledForProject: resolveProjectProviderInstanceEnabled(
            settings,
            shell?.projectId ?? null,
            registeredId,
          ),
          supportsModel: null,
          limitedUntil: null,
        }));
  const instanceId = yield* placeInPool({
    table,
    kind: "switch",
    requestedInstanceId: selection.instanceId,
    currentInstanceId: shell?.providerInstanceId ?? null,
    driver: undefined,
    model: selection.model,
    seedKey: command.commandId,
    candidates,
  });
  return { ...command, modelSelection: { ...selection, instanceId } };
});

/** Wraps orchestrator dispatch so pool switches and creates resolve without inline upstream wiring. */
export const wrapOrchestratorDispatch = Effect.fn("providerPools.wrapOrchestratorDispatch")(
  function* <A, E, R, SettingsR, ShellE, ReceiptE>(
    dispatchWithReceipt: (command: OrchestrationV2ServerCommand) => Effect.Effect<A, E, R>,
    deps: {
      readonly serverSettings: { readonly getSettings: GetSettings<SettingsR> };
      readonly projectionStore: {
        readonly getThreadShell: (threadId: ThreadId) => Effect.Effect<
          {
            readonly projectId: ProjectId;
            readonly providerInstanceId: ProviderInstanceId;
          } | null,
          ShellE
        >;
      };
      readonly providerAdapters: {
        readonly list: () => Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
      };
      readonly commandReceipts: {
        readonly getByCommandId: (
          commandId: CommandId,
        ) => Effect.Effect<Option.Option<unknown>, ReceiptE>;
      };
      readonly mapError: (
        command: OrchestrationV2ServerCommand,
        cause: ProviderPoolPlacementError | ProviderPoolUnresolvedError | ServerSettingsError,
      ) => E;
    },
  ) {
    const providerRegistry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    return Effect.fnUntraced(function* (command: OrchestrationV2ServerCommand) {
      const resolved = yield* resolveCommandPool(command, {
        getSettings: deps.serverSettings.getSettings,
        threadShell: (threadId) =>
          deps.projectionStore.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null)),
        registeredInstanceIds: deps.providerAdapters.list(),
        providers: Option.isSome(providerRegistry)
          ? providerRegistry.value.getProviders
          : undefined,
        hasReceipt: (commandId) =>
          deps.commandReceipts.getByCommandId(commandId).pipe(
            Effect.map(Option.isSome),
            Effect.orElseSucceed(() => false),
          ),
      }).pipe(Effect.mapError((cause) => deps.mapError(command, cause)));
      return yield* dispatchWithReceipt(resolved);
    });
  },
);
