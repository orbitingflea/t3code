import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";

/**
<<<<<<< origin/main
 * Codex writes `tokens` only for ChatGPT logins and omits the key for API-key,
 * agent-identity, and personal-access-token logins, so its absence is a
 * supported install and not a malformed file. `account_id` is the ChatGPT
 * workspace, which a whole Team shares; the `id_token` names the person.
 */
export const CodexAuthJsonSchema = Schema.Struct({
  tokens: Schema.optionalKey(
    Schema.Struct({
      account_id: Schema.String,
      id_token: Schema.optionalKey(Schema.String),
    }),
  ),
});

/** `userID` is random per machine. `oauthAccount` is present only while Claude Code is logged in. */
const ClaudeJsonSchema = Schema.Struct({
  userID: Schema.optionalKey(Schema.String),
  oauthAccount: Schema.optionalKey(
    Schema.Struct({
      accountUuid: Schema.optionalKey(Schema.String),
    }),
  ),
});

// `sub` names the login method (`google-oauth2|…`), so one person can have several.
// `user_id` (`user-…`) is the OpenAI account and is the same for every login.
const IdTokenClaims = Schema.Struct({
  "https://api.openai.com/auth": Schema.Struct({ user_id: Schema.NonEmptyString }),
});
const decodeIdTokenClaims = Schema.decodeUnknownOption(Schema.fromJsonString(IdTokenClaims));

/**
=======
>>>>>>> upstream/main
 * Who an install belongs to, from strongest to weakest. `connect` is the T3
 * Connect account. `device` is a client device that connected.
 */
export const TelemetryOwnerSource = Schema.Literals(["connect", "device"]);
export type TelemetryOwnerSource = typeof TelemetryOwnerSource.Type;

export interface TelemetryOwner {
  readonly source: TelemetryOwnerSource;
  /** `hashTelemetryId` of the source's raw id. */
  readonly ownerId: string;
}

class TelemetryIdentityReadError extends Schema.TaggedError<TelemetryIdentityReadError>()(
  "TelemetryIdentityReadError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read anonymous telemetry identity at '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdGenerationError extends Schema.TaggedError<TelemetryAnonymousIdGenerationError>()(
  "TelemetryAnonymousIdGenerationError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate anonymous telemetry identity for '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdPersistenceError extends Schema.TaggedError<TelemetryAnonymousIdPersistenceError>()(
  "TelemetryAnonymousIdPersistenceError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist anonymous telemetry identity at '${this.filePath}'.`;
  }
}

type TelemetryIdentityError =
  | TelemetryIdentityReadError
  | TelemetryAnonymousIdGenerationError
  | TelemetryAnonymousIdPersistenceError;

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

const getTelemetryIdentityCauseAnnotations = (cause: unknown) => {
  if (cause instanceof PlatformError.PlatformError) {
    return {
      causeKind: "platform",
      platformReason: cause.reason._tag,
    };
  }
  return { causeKind: "other" };
};

const logTelemetryIdentityError = (error: TelemetryIdentityError) =>
  Effect.logWarning(error.message).pipe(
    Effect.annotateLogs({
      errorTag: error._tag,
      filePath: error.filePath,
      ...getTelemetryIdentityCauseAnnotations(error.cause),
      ...(error.stack === undefined ? {} : { errorStack: error.stack }),
    }),
  );

const readIdentityFile = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotFoundError(cause)
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(new TelemetryIdentityReadError({ filePath, cause })),
    }),
  );

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig.ServerConfig;

  const existing = yield* readIdentityFile(fileSystem, anonymousIdPath);
  if (Option.isSome(existing)) {
    return existing.value;
  }

  const anonymousId = yield* SecureRandom.SecureRandom.pipe(
    Effect.flatMap((crypto) => crypto.uuidV4()),
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdGenerationError({
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );
  yield* writeFileStringAtomically({ filePath: anonymousIdPath, contents: anonymousId }).pipe(
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdPersistenceError({
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );

  return anonymousId;
});

/**
 * `distinctId` and `installId` are the same hash of a random id kept in the state
 * directory. Identity never comes from a provider's sign-in files or account. Both
 * names are sent because the ingest side reads each. Null disables telemetry.
 */
export const getTelemetryIdentity = upsertAnonymousId.pipe(
  Effect.map(hashTelemetryId),
  Effect.catch((error) => logTelemetryIdentityError(error).pipe(Effect.as(null))),
  Effect.map((installId) => ({ distinctId: installId, installId })),
  Effect.withSpan("getTelemetryIdentity"),
);

/**
 * The owner the server can read without a client: the linked T3 Connect
 * account. Clients add `connect` and `device` owners when they connect.
 */
export const getServerOwners = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const connectUser = yield* secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read the linked T3 Connect account for telemetry", {
        errorTag: cause._tag,
      }).pipe(Effect.as(Option.none<string>())),
    ),
  );
  return Option.isSome(connectUser) && connectUser.value.trim() !== ""
    ? [{ source: "connect", ownerId: hashTelemetryId(connectUser.value) } satisfies TelemetryOwner]
    : [];
}).pipe(Effect.withSpan("getServerOwners"));
