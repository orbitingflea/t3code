import { UsageLimitSourceError, type UsageLimitSourceConfig } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CLAIM_OUTCOMES,
  ClaimResponse,
  ClaudeResetCreditError,
  GRANT_ID,
  PROGRAM,
  REQUEST_ID,
  claudeResetCreditsToContract,
} from "../../provider/claudeResetCredits.ts";

type HubAccount = {
  readonly auth_index: string;
  readonly provider: string;
  readonly email?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly organization_uuid?: string | undefined;
};

export type ClaudeLogin = {
  readonly email: string | undefined;
  readonly organizationId: string | undefined;
};

const ClaudeWindow = Schema.Struct({
  utilization: Schema.Number,
  resets_at: Schema.NullOr(Schema.String),
});
const ClaudeUsage = Schema.Struct({
  cedar_ember: Schema.optional(Schema.NullOr(Schema.Unknown)),
  five_hour: Schema.optional(Schema.NullOr(ClaudeWindow)),
  seven_day: Schema.optional(Schema.NullOr(ClaudeWindow)),
  limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        percent: Schema.optional(Schema.NullOr(Schema.Number)),
        resets_at: Schema.optional(Schema.NullOr(Schema.String)),
        scope: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              model: Schema.optional(Schema.NullOr(Schema.Struct({ display_name: Schema.String }))),
            }),
          ),
        ),
      }),
    ),
  ),
});
const ApiResponse = Schema.Struct({ status_code: Schema.Number, body: Schema.String });

const decodeClaudeUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeUsage));
const decodeApiResponse = Schema.decodeUnknownEffect(ApiResponse);
const decodeClaimResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaimResponse));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);

const CLAUDE_API = "https://api.anthropic.com/api";
export const CLAUDE_USAGE_URL = `${CLAUDE_API}/oauth/usage?cedar_ember=1&skip_spend=1`;

/** A redeem waits on the hub's own call to the provider, which can take longer than a read. */
export const managementTimeout = (body: unknown) =>
  typeof body === "object" && body !== null && "data" in body ? "30 seconds" : "15 seconds";

/** Claude reads and reset claims through a CLIProxyAPI hub's management API. */
export const makeClaudeHub = Effect.fn("makeClaudeHub")(function* <A extends HubAccount>(
  management: (
    config: UsageLimitSourceConfig,
    path: string,
    body?: unknown,
  ) => Effect.Effect<unknown, UsageLimitSourceError>,
  authFiles: (
    config: UsageLimitSourceConfig,
  ) => Effect.Effect<ReadonlyArray<A>, UsageLimitSourceError | Schema.SchemaError>,
) {
  const crypto = yield* Crypto.Crypto;

  const apiCall = Effect.fn("ClaudeHub.apiCall")(function* (
    config: UsageLimitSourceConfig,
    account: HubAccount,
    url: string,
    data?: unknown,
  ) {
    const raw = yield* management(config, "api-call", {
      auth_index: account.auth_index,
      method: data === undefined ? "GET" : "POST",
      url,
      header: {
        Authorization: "Bearer $TOKEN$",
        "anthropic-beta": "oauth-2025-04-20",
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(data === undefined ? {} : { data: yield* encodeJson(data) }),
    });
    return yield* decodeApiResponse(raw);
  });

  const resetCredits = Effect.fn("ClaudeHub.resetCredits")(function* (
    usage: typeof ClaudeUsage.Type,
  ) {
    return claudeResetCreditsToContract(
      usage.cedar_ember,
      DateTime.toEpochMillis(yield* DateTime.now),
    );
  });

  /** Adds reset credits from a usage answer to a hub account read from it. */
  const withResetCredits = Effect.fn("ClaudeHub.withResetCredits")(function* <
    A extends { readonly usageLimits: object },
  >(body: string, account: A) {
    const credits = yield* resetCredits(yield* decodeClaudeUsage(body));
    return credits
      ? { ...account, usageLimits: { ...account.usageLimits, resetCredits: credits } }
      : account;
  });

  /** Usage in the Claude SDK's get_usage shape, plus reset credits. */
  const usage = Effect.fn("ClaudeHub.usage")(
    function* (config: UsageLimitSourceConfig, account: HubAccount) {
      const response = yield* apiCall(config, account, CLAUDE_USAGE_URL);
      if (response.status_code < 200 || response.status_code >= 300) {
        return yield* new UsageLimitSourceError({
          detail: `The provider refused the hub request (HTTP ${response.status_code}).`,
        });
      }
      const usage = yield* decodeClaudeUsage(response.body);
      const model_scoped = (usage.limits ?? []).flatMap((limit) =>
        limit.kind === "weekly_scoped" && limit.scope?.model && typeof limit.percent === "number"
          ? [
              {
                display_name: limit.scope.model.display_name,
                utilization: limit.percent,
                resets_at: limit.resets_at ?? null,
              },
            ]
          : [],
      );
      return {
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: usage.five_hour ?? null,
            seven_day: usage.seven_day ?? null,
            model_scoped,
          },
        },
        resetCredits: yield* resetCredits(usage),
      };
    },
    Effect.mapError((error) =>
      isUsageLimitSourceError(error)
        ? error
        : new UsageLimitSourceError({ detail: "The hub returned an unexpected usage response." }),
    ),
  );

  const claim = Effect.fn("ClaudeHub.claim")(function* (
    config: UsageLimitSourceConfig,
    account: HubAccount,
    grantId: string,
    requestId: string,
  ) {
    if (!GRANT_ID.test(grantId) || !REQUEST_ID.test(requestId)) {
      return yield* new ClaudeResetCreditError({ reason: "malformedCredit" });
    }
    const organization = account.organization_uuid?.trim();
    if (!organization) {
      return yield* new UsageLimitSourceError({
        detail: "The hub does not know this Claude account's organization.",
      });
    }
    const response = yield* apiCall(
      config,
      account,
      `${CLAUDE_API}/organizations/${encodeURIComponent(organization)}/reset_rate_limits`,
      { program: PROGRAM, grant_id: grantId, request_id: requestId },
    );
    if (response.status_code === 429) {
      return yield* new ClaudeResetCreditError({ reason: "rateLimited" });
    }
    if (response.status_code === 401 || response.status_code === 403) {
      return yield* new ClaudeResetCreditError({ reason: "signedOut" });
    }
    if (response.status_code < 200 || response.status_code >= 300) {
      return yield* new ClaudeResetCreditError({ reason: "requestFailed" });
    }
    const body = yield* decodeClaimResponse(response.body).pipe(
      Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "requestFailed", cause })),
    );
    if (body.result === "cooldown") {
      return yield* new ClaudeResetCreditError({ reason: "coolingDown" });
    }
    // Unknown outcomes retain the request ID so retries address the same claim.
    if (body.result === "unavailable") {
      return yield* new ClaudeResetCreditError({ reason: "unconfirmed" });
    }
    return CLAIM_OUTCOMES[body.result];
  });

  const clearCooldown = (config: UsageLimitSourceConfig, account: HubAccount) =>
    management(config, "reset-quota", { auth_index: account.auth_index });

  /**
   * The source account holding a directly signed-in Claude login, if exactly one source has it.
   * A source that cannot list its accounts fails the lookup; it never counts as no match.
   */
  const findLogin = Effect.fn("ClaudeHub.findLogin")(function* (
    sources: ReadonlyArray<UsageLimitSourceConfig>,
    login: ClaudeLogin,
  ) {
    const { email, organizationId } = login;
    if (!email || !organizationId) return undefined;
    for (const config of sources) {
      if (!config.enabled || !config.managementKey) continue;
      const accounts = yield* authFiles(config).pipe(
        Effect.mapError((error) =>
          isUsageLimitSourceError(error)
            ? error
            : new UsageLimitSourceError({ detail: "The hub could not list accounts." }),
        ),
      );
      const matches = accounts.filter(
        (account) =>
          account.provider === "claude" &&
          !account.disabled &&
          account.email?.toLowerCase() === email.toLowerCase() &&
          account.organization_uuid === organizationId,
      );
      if (matches.length === 1) return { config, account: matches[0]! };
    }
    return undefined;
  });

  // Claim errors stay typed so the caller's coordinator keeps the request id for retries.
  const claimLogin = Effect.fn("ClaudeHub.claimLogin")(function* (
    config: UsageLimitSourceConfig,
    account: HubAccount,
    grantId: string,
    requestId: string,
  ) {
    const outcome = yield* claim(config, account, grantId, requestId);
    if (outcome === "reset" || outcome === "alreadyRedeemed") {
      yield* clearCooldown(config, account).pipe(Effect.ignore);
    }
    return outcome;
  });

  /** Redeems a reset on a Claude account the hub lists. */
  const consume = Effect.fn("ClaudeHub.consume")(function* (
    config: UsageLimitSourceConfig,
    account: HubAccount,
    grantId: string,
  ) {
    if (account.disabled) {
      return yield* new UsageLimitSourceError({
        detail: "The hub account is missing or disabled.",
      });
    }
    // A Claude grant can hold several resets, so each claim needs its own request id.
    const outcome = yield* claim(config, account, grantId, yield* crypto.randomUUIDv4()).pipe(
      Effect.catchTags({
        ClaudeResetCreditError: (error) =>
          Effect.fail(new UsageLimitSourceError({ detail: error.message })),
      }),
    );
    if (outcome !== "reset" && outcome !== "alreadyRedeemed") return { outcome };
    const cleared = yield* clearCooldown(config, account).pipe(Effect.result);
    return {
      outcome,
      ...(cleared._tag === "Failure"
        ? {
            warning:
              "Credit redeemed, but the hub cooldown could not be cleared. Routing may resume after its cooldown expires.",
          }
        : {}),
    } as const;
  });

  return { withResetCredits, usage, findLogin, claimLogin, consume };
});
