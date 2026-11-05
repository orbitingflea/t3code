import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

const MAX_BODY_BYTES = 4096;
const DEDUPE_MILLIS = 60_000;

// The SDK types lack unifiedWindows; read only what the receiver relies on.
const ExportableRateLimitInfo = Schema.Struct({
  status: Schema.String,
  unifiedWindows: Schema.Record(
    Schema.String,
    Schema.Struct({ utilization: Schema.Finite, resetsAt: Schema.Finite }),
  ),
});
const isExportable = Schema.is(ExportableRateLimitInfo);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const describeFailure = (error: unknown) => {
  if (HttpClientError.isHttpClientError(error)) {
    return error.reason._tag === "StatusCodeError"
      ? `status ${error.reason.response.status}`
      : error.reason._tag;
  }
  return error instanceof Error ? error.name : "unknown error";
};

/**
 * Moves T3CODE_CLAUDE_USAGE_EXPORT_URL and _KEY out of `environment`, so no process started from it
 * sees them. Posts rate_limit_info to the URL without waiting, with the key as Bearer if not blank,
 * logging failures at debug. Skips a blank URL, info that fails the usage-window schema or has no
 * windows, the same home and info within 60 s, and a body over 4096 bytes.
 */
export const makeClaudeUsageExport = (environment: NodeJS.ProcessEnv) => {
  const url = environment.T3CODE_CLAUDE_USAGE_EXPORT_URL?.trim();
  const key = environment.T3CODE_CLAUDE_USAGE_EXPORT_KEY?.trim();
  delete environment.T3CODE_CLAUDE_USAGE_EXPORT_URL;
  delete environment.T3CODE_CLAUDE_USAGE_EXPORT_KEY;
  const lastSentAt = new Map<string, number>();

  return Effect.fn("ClaudeUsageExport.export")(function* (home: string, rateLimitInfo: unknown) {
    if (
      !url ||
      !isExportable(rateLimitInfo) ||
      Object.keys(rateLimitInfo.unifiedWindows).length === 0
    ) {
      return;
    }
    const receivedAt = yield* DateTime.now;
    const now = DateTime.toEpochMillis(receivedAt);
    for (const [key, sentAt] of lastSentAt) {
      if (now - sentAt >= DEDUPE_MILLIS) lastSentAt.delete(key);
    }
    const info = encodeJson(rateLimitInfo);
    const dedupeKey = `${home}\n${info}`;
    if (lastSentAt.has(dedupeKey)) return;

    const body = encodeJson({
      v: 1,
      kind: "claude.rate_limit",
      at: DateTime.formatIso(receivedAt),
      home,
      rate_limit_info: rateLimitInfo,
    });
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return;
    lastSentAt.set(dedupeKey, now);

    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(body, "application/json"),
      key ? HttpClientRequest.bearerToken(key) : (request) => request,
    );
    yield* HttpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout("2 seconds"),
      Effect.catch((error) =>
        Effect.logDebug(`Usage event export failed: ${describeFailure(error)}`),
      ),
      Effect.provide(FetchHttpClient.layer),
      // Client spans record the full URL, query string included.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.forkDetach,
    );
  });
};

// Built when the server's code loads, before it starts any process.
export const exportClaudeUsageEvent = makeClaudeUsageExport(process.env);
