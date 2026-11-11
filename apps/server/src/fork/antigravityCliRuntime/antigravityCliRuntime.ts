import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

/**
 * Where a runtime keeps its sessions and its login. The managed runtime uses the profile T3
 * gives it as GEMINI_HOME. The agy CLI ignores GEMINI_HOME and uses the user's own folder.
 */
export interface AntigravityRuntimeState {
  readonly runtime: "managed" | "cli";
  readonly root: string;
  readonly appFolder: string;
  readonly tokenFile: string;
}

export const managedAntigravityRuntimeState = (
  profileDirectory: string,
): AntigravityRuntimeState => ({
  runtime: "managed",
  root: profileDirectory,
  appFolder: "antigravity-acp",
  tokenFile: "acp_token.json",
});

export function antigravityRuntimeState(
  executable: { readonly harnessPath: string | null },
  input: {
    readonly profileDirectory: string;
    readonly userHome: string;
    readonly path: Path.Path;
  },
): AntigravityRuntimeState {
  return executable.harnessPath === null
    ? {
        runtime: "cli",
        root: input.path.join(input.userHome, ".gemini"),
        appFolder: "antigravity-cli",
        tokenFile: "antigravity-oauth-token",
      }
    : managedAntigravityRuntimeState(input.profileDirectory);
}

/** The state a caller was given, or the managed profile's when it was given none. */
export const antigravityRuntimeStateOf = (options: {
  readonly profileDirectory: string;
  readonly runtimeState?: Effect.Effect<AntigravityRuntimeState> | undefined;
}) =>
  options.runtimeState ?? Effect.succeed(managedAntigravityRuntimeState(options.profileDirectory));

export const antigravityTokenPath = (state: AntigravityRuntimeState, path: Path.Path) =>
  path.join(state.root, state.appFolder, state.tokenFile);

/** The CLI runs shell commands in an additional directory instead of the session's cwd. */
export const antigravitySessionDirectories = (
  state: AntigravityRuntimeState,
  attachmentsDir: string,
): ReadonlyArray<string> => (state.runtime === "cli" ? [] : [attachmentsDir]);

/**
 * `agy acp` runs a `/compact` prompt as its own command. The managed runtime reads it as chat,
 * so its sessions offer no compaction. The runtime is read as each session opens.
 */
export const withAntigravityCliCompaction =
  <Session extends { readonly compactThread?: unknown }, Input, E, R>(
    openSession: (input: Input) => Effect.Effect<Session, E, R>,
    options: Parameters<typeof antigravityRuntimeStateOf>[0],
  ) =>
  (input: Input): Effect.Effect<Session, E, R> =>
    Effect.zipWith(openSession(input), antigravityRuntimeStateOf(options), (session, state) => {
      if (state.runtime === "cli") return session;
      const { compactThread: _, ...managed } = session;
      return managed as Session;
    });

const RefreshToken = Schema.Struct({ refresh_token: Schema.NonEmptyString });
const decodeRefreshToken = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([RefreshToken, Schema.Struct({ token: RefreshToken })])),
);

// A new process may rewrite project_id after onboarding; the refresh token alone names the login.
export const readAntigravityAccount = Effect.fn("AntigravityAdapterV2.readAccount")(function* (
  runtimeState: Effect.Effect<AntigravityRuntimeState>,
  services: {
    readonly digest: Digest.Digest["Service"];
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  },
) {
  const state = yield* runtimeState;
  const login = Option.flatMap(
    yield* services.fileSystem
      .readFileString(antigravityTokenPath(state, services.path))
      .pipe(Effect.option),
    decodeRefreshToken,
  );
  if (Option.isNone(login)) return Option.none<string>();
  const { refresh_token } = "token" in login.value ? login.value.token : login.value;
  const digest = yield* services.digest
    .digest(Digest.sha256, new TextEncoder().encode(refresh_token))
    .pipe(Effect.option);
  return Option.map(digest, Hex.encode);
});

// google.rpc.Code names. The CLI's error step is length-prefixed, so a length byte that may be
// a capital letter leads the status; only a known name finds where the status starts.
const CLI_API_ERROR =
  /(CANCELLED|UNKNOWN|INVALID_ARGUMENT|DEADLINE_EXCEEDED|NOT_FOUND|ALREADY_EXISTS|PERMISSION_DENIED|RESOURCE_EXHAUSTED|FAILED_PRECONDITION|ABORTED|OUT_OF_RANGE|UNIMPLEMENTED|INTERNAL|UNAVAILABLE|DATA_LOSS|UNAUTHENTICATED) \(code (\d{3})\): ([^\p{Cc}]+)/u;

/** The CLI's `STATUS (code NNN): message`, in the managed pattern's group order: code, message, status. */
export function antigravityCliApiError(text: string) {
  const match = CLI_API_ERROR.exec(text);
  return match === null ? null : ([match[0], match[2], match[3], match[1]] as const);
}

const advertisesSystemPromptAppend = Schema.is(
  Schema.Struct({
    antigravity: Schema.Struct({ systemPrompt: Schema.Struct({ append: Schema.Literal(true) }) }),
  }),
);

export const antigravityAdvertisesSystemPromptAppend = (
  initializeResult: EffectAcpSchema.InitializeResponse,
) => advertisesSystemPromptAppend(initializeResult.agentCapabilities?._meta);

const CliLogin = Schema.Struct({
  token: Schema.Struct({
    access_token: Schema.NonEmptyString,
    refresh_token: Schema.NonEmptyString,
    expiry: Schema.NonEmptyString,
  }),
});
const decodeCliLogin = Schema.decodeEffect(Schema.fromJsonString(CliLogin));

interface AntigravityAccess {
  readonly access_token: string;
  readonly expires_in: number;
}

/**
 * Undefined for the managed runtime. The CLI's login holds no OAuth client, so T3 cannot
 * refresh it. The access token the CLI last saved stands in for a refresh until it expires.
 */
export const readAntigravityCliUsageLogin = Effect.fn("readAntigravityCliUsageLogin")(function* (
  state: AntigravityRuntimeState,
  text: string,
  checkedAt: string,
) {
  if (state.runtime !== "cli") return undefined;
  const { token } = yield* decodeCliLogin(text);
  const expiresIn = (Date.parse(token.expiry) - (yield* Clock.currentTimeMillis)) / 1000;
  const login: {
    readonly client_id: string;
    readonly client_secret: string;
    readonly refresh_token: string;
    readonly project_id?: string;
  } = { client_id: "", client_secret: "", refresh_token: token.refresh_token };
  const access: AntigravityAccess = { access_token: token.access_token, expires_in: expiresIn };
  return {
    token: login,
    access,
    unavailable:
      expiresIn > 60
        ? undefined
        : makeUnavailableUsageLimits({
            checkedAt,
            reason: "unsupported",
            message:
              "The Antigravity CLI's access has expired, and only the CLI can renew it. Limits show again after its next turn.",
          }),
  };
});

/** A CLI login's saved access replaces the refresh request, which is then never sent. */
export const orAntigravityCliAccess =
  (cli: { readonly access: AntigravityAccess } | undefined) =>
  <E, R>(refresh: Effect.Effect<AntigravityAccess, E, R>): Effect.Effect<AntigravityAccess, E, R> =>
    cli === undefined ? refresh : Effect.succeed(cli.access);
