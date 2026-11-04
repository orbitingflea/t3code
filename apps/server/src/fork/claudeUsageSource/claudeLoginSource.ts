import {
  UsageLimitSourceError,
  type ClaudeSettings,
  type ServerProviderResetCredits,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { requireSettingsSecret } from "../../secrets/settingsSecretValue.ts";
import * as Settings from "../../serverSettings.ts";
import { makeCliproxyApi } from "../../usage/cliproxyApi.ts";
import { probeClaudeCapabilities } from "../../provider/ClaudeProvider.ts";

const AccountConfig = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({
      emailAddress: Schema.optional(Schema.String),
      organizationUuid: Schema.optional(Schema.String),
    }),
  ),
});
const decodeAccountConfig = Schema.decodeEffect(Schema.fromJsonString(AccountConfig));

/**
 * A Claude login held by a usage source is read and redeemed only through that source.
 * With T3CODE_CLAUDE_USAGE_SOURCE_ONLY=1 a login no source holds is never read directly.
 */
export const makeClaudeLoginSource = Effect.fn("makeClaudeLoginSource")(function* (
  accountConfigPath: string,
  processEnv: NodeJS.ProcessEnv,
) {
  const { claude } = yield* makeCliproxyApi;
  const serverSettings = yield* Effect.serviceOption(Settings.ServerSettingsService);
  const secrets = yield* Effect.serviceOption(SecretResolver.SecretResolver);
  const fileSystem = yield* FileSystem.FileSystem;
  const sourceOnly = processEnv.T3CODE_CLAUDE_USAGE_SOURCE_ONLY === "1";
  const sourceCredits = yield* Ref.make(Option.none<ServerProviderResetCredits | undefined>());

  const readLogin = fileSystem.readFileString(accountConfigPath).pipe(
    Effect.flatMap(decodeAccountConfig),
    Effect.map(({ oauthAccount }) => ({
      email: oauthAccount?.emailAddress?.trim() || undefined,
      organizationId: oauthAccount?.organizationUuid?.trim() || undefined,
    })),
    Effect.orElseSucceed(() => ({ email: undefined, organizationId: undefined })),
  );

  /** A source whose key its secret provider cannot give fails, so it never counts as no match. */
  const readHub = Effect.fn("ClaudeLoginSource.readHub")(function* (
    config: UsageLimitSourceConfig,
  ) {
    if (typeof config.managementKey === "string") {
      return { url: config.url, managementKey: config.managementKey };
    }
    const managementKey = Option.isSome(secrets)
      ? yield* requireSettingsSecret(secrets.value, config.managementKey).pipe(Effect.option)
      : Option.none<string>();
    if (Option.isNone(managementKey)) {
      return yield* new UsageLimitSourceError({
        detail: "Could not read the management key from its secret provider.",
      });
    }
    return { url: config.url, managementKey: managementKey.value };
  });

  const findSource = Effect.fn("ClaudeLoginSource.findSource")(function* () {
    const login = yield* readLogin;
    const source = Option.isNone(serverSettings)
      ? undefined
      : yield* serverSettings.value.getSettings.pipe(
          Effect.mapError(
            () => new UsageLimitSourceError({ detail: "The usage sources could not be read." }),
          ),
          Effect.flatMap((settings) =>
            Effect.forEach(
              Object.values(settings.usageLimitSources).filter((config) => config.enabled),
              readHub,
            ),
          ),
          Effect.flatMap((hubs) =>
            claude.findLogin(
              hubs.filter((hub) => hub.managementKey.length > 0),
              login,
            ),
          ),
        );
    if (!source && sourceOnly) {
      return yield* new UsageLimitSourceError({
        detail: "No usage source holds this Claude login.",
      });
    }
    return source;
  });

  /** Probes Claude, taking usage from the source holding the login instead of from Claude. */
  const probe = Effect.fn("ClaudeLoginSource.probe")(function* (
    settings: ClaudeSettings,
    environment: NodeJS.ProcessEnv,
    cwd: string,
  ) {
    const usageCheckedAt = DateTime.formatIso(yield* DateTime.now);
    const viaSource = yield* findSource().pipe(
      Effect.flatMap((source) =>
        source ? claude.usage(source.hub, source.account).pipe(Effect.asSome) : Effect.succeedNone,
      ),
      Effect.result,
    );
    const direct = Result.isSuccess(viaSource) && Option.isNone(viaSource.success);
    const capabilities = yield* probeClaudeCapabilities(settings, environment, cwd, direct);
    yield* Ref.set(
      sourceCredits,
      Result.isSuccess(viaSource)
        ? Option.map(viaSource.success, (usage) => usage.resetCredits)
        : Option.none(),
    );
    if (Result.isFailure(viaSource)) {
      return { ...capabilities, usageError: { message: viaSource.failure.detail } };
    }
    if (Option.isNone(viaSource.success)) return capabilities;
    const { response, readAt } = viaSource.success.value;
    return { ...capabilities, usage: response, usageCheckedAt, usageReadAt: readAt };
  });

  /** Reset credits from the source that answered the last probe, else the direct read. */
  const resetCredits = <E, R>(
    direct: Effect.Effect<ServerProviderResetCredits | undefined, E, R>,
  ) =>
    Ref.get(sourceCredits).pipe(
      Effect.flatMap(Option.match({ onNone: () => direct, onSome: Effect.succeed })),
    );

  /** Sends a claim to the source holding the login instead of to Claude. */
  const claimRoute = Effect.fn("ClaudeLoginSource.claimRoute")(function* (grantId: string) {
    const source = yield* findSource();
    return (requestId: string) =>
      <A, E, R>(direct: Effect.Effect<A, E, R>) =>
        source ? claude.claimLogin(source.hub, source.account, grantId, requestId) : direct;
  });

  return { probe, resetCredits, claimRoute };
});
