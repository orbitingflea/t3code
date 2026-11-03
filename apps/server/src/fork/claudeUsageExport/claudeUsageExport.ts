import * as HostProcess from "@t3tools/shared/HostProcess";
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
 * Posts Claude rate_limit_info to T3CODE_CLAUDE_USAGE_EXPORT_URL (Bearer T3CODE_CLAUDE_USAGE_EXPORT_KEY).
 * Skips info with no usage windows, the same home and info sent in the last 60 s,
 * and bodies over 4096 bytes. Does not wait for, or report failures from, the endpoint.
 */
export const makeClaudeUsageExport = () => {
  const lastSentAt = new Map<string, number>();

  return Effect.fn("ClaudeUsageExport.export")(function* (home: string, rateLimitInfo: unknown) {
    const environment = yield* HostProcess.Environment;
    const url = environment.T3CODE_CLAUDE_USAGE_EXPORT_URL?.trim();
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

    const key = environment.T3CODE_CLAUDE_USAGE_EXPORT_KEY?.trim();
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

export const exportClaudeUsageEvent = makeClaudeUsageExport();
