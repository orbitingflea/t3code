import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * Codex writes `tokens` only for ChatGPT logins and omits the key for API-key,
 * agent-identity, and personal-access-token logins, so its absence is a
 * supported install and not a malformed file. `account_id` is the ChatGPT
 * workspace, which a whole Team shares; the `id_token` names the person.
 */
const CodexAuthJsonSchema = Schema.Struct({
  tokens: Schema.optionalKey(
    Schema.Struct({
      account_id: Schema.String,
      id_token: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeCodexAuthJson = Schema.decodeUnknownOption(Schema.fromJsonString(CodexAuthJsonSchema));

// `sub` names the login method (`google-oauth2|…`), so one person can have several.
// `user_id` (`user-…`) is the OpenAI account and is the same for every login.
const IdTokenClaims = Schema.Struct({
  "https://api.openai.com/auth": Schema.Struct({ user_id: Schema.NonEmptyString }),
});
const decodeIdTokenClaims = Schema.decodeUnknownOption(Schema.fromJsonString(IdTokenClaims));

const openAiUserId = (idToken: string) => {
  const payload = Base64Url.decodeString(idToken.split(".")[1] ?? "");
  return Result.isSuccess(payload)
    ? Option.map(
        decodeIdTokenClaims(payload.success),
        (claims) => claims["https://api.openai.com/auth"].user_id,
      )
    : Option.none<string>();
};

// A Team shares `account_id`; the id_token's user id tells its seats apart.
export const readCodexAccount = Effect.fn("CodexAdapterV2.readAccount")(function* (
  fileSystem: FileSystem.FileSystem,
  authPath: string,
) {
  const text = yield* fileSystem.readFileString(authPath).pipe(Effect.option);
  const tokens = Option.flatMap(Option.flatMap(text, decodeCodexAuthJson), (auth) =>
    Option.fromUndefinedOr(auth.tokens),
  );
  return Option.map(tokens, (tokens) => {
    const userId = Option.fromUndefinedOr(tokens.id_token).pipe(
      Option.flatMap(openAiUserId),
      Option.getOrElse(() => ""),
    );
    return `${tokens.account_id}\n${userId}`;
  });
});
