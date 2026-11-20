import type { ProviderInstanceId, ResolvedProviderInstanceEnvironment } from "@t3tools/contracts";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";

export const PROVIDER_INSTANCE_ID_ENV = "T3CODE_PROVIDER_INSTANCE_ID";
export const HOOK_STATE_DB_ENV = "T3CODE_HOOK_STATE_DB";

/**
 * Tells hooks inside a provider process which instance started it and where the server's state
 * database is, for read-only lookups. It never sets T3CODE_HOME: a `t3` command an agent runs
 * reads that variable as its own data directory.
 */
export const withProviderProcessIdentityEnv = (
  instanceId: ProviderInstanceId,
  stateDbPath: string,
  environment: ResolvedProviderInstanceEnvironment,
): ResolvedProviderInstanceEnvironment => [
  ...environment.filter(
    (variable) => variable.name !== PROVIDER_INSTANCE_ID_ENV && variable.name !== HOOK_STATE_DB_ENV,
  ),
  { name: PROVIDER_INSTANCE_ID_ENV, value: instanceId, sensitive: false },
  { name: HOOK_STATE_DB_ENV, value: stateDbPath, sensitive: false },
];

export const withProviderProcessIdentity = <R>(
  drivers: ReadonlyArray<AnyProviderDriver<R>>,
  stateDbPath: string,
): ReadonlyArray<AnyProviderDriver<R>> =>
  drivers.map((driver) => ({
    ...driver,
    create: (input) =>
      driver.create({
        ...input,
        environment: withProviderProcessIdentityEnv(
          input.instanceId,
          stateDbPath,
          input.environment,
        ),
      }),
  }));
