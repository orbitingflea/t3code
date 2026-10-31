import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { makeCliproxyApi } from "./cliproxyApi.ts";

const config = {
  kind: "cliproxy",
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
} as const;
const accounts = [
  {
    id: "first.json",
    auth_index: "a",
    provider: "codex",
    email: "first@example.com",
    id_token: { chatgpt_account_id: "account-a" },
  },
  {
    id: "second.json",
    auth_index: "b",
    provider: "codex",
    email: "second@example.com",
    id_token: { chatgpt_account_id: "account-b" },
  },
];
const credit = (id: string, expires_at = "2099-01-01T00:00:00Z") => ({
  id,
  expires_at,
  status: "available",
  reset_type: "codex_rate_limits",
});
const RequestBody = Schema.Struct({
  auth_index: Schema.String,
  method: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  header: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  data: Schema.optional(Schema.String),
});
type RequestBody = typeof RequestBody.Type;
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture(
  options: {
    accounts?: Array<
      (typeof accounts)[number] & {
        label?: string;
        disabled?: boolean;
        organization_uuid?: string;
        id_token: { chatgpt_account_id: string; plan_type?: string; chatgpt_plan_type?: string };
      }
    >;
    upstream?: (request: RequestBody) => { status: number; body: unknown };
    cooldownStatus?: number;
    redeemDelay?: Duration.Input;
  } = {},
) {
  const requests: Array<{ path: string; body?: RequestBody }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer management-secret");
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? decodeRequest(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ path, ...(body ? { body } : {}) });
      if (path.endsWith("/auth-files"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ files: options.accounts ?? accounts }),
        );
      if (path.endsWith("/reset-quota"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({}, { status: options.cooldownStatus ?? 200 }),
        );
      expect(path).toMatch(/\/v0\/management\/api-call$/);
      expect(body?.header?.Authorization).toBe("Bearer $TOKEN$");
      const upstream = options.upstream?.(body!) ?? {
        status: 200,
        body: body?.url?.endsWith("/consume")
          ? { code: "reset" }
          : body?.url?.endsWith("/rate-limit-reset-credits")
            ? {
                credits: [
                  credit("later", "2099-02-01T00:00:00Z"),
                  credit("first"),
                  credit("expired", "2000-01-01T00:00:00Z"),
                  { ...credit("used"), status: "redeemed" },
                ],
              }
            : {
                plan_type: "pro",
                rate_limit: {
                  secondary_window: {
                    used_percent: 78,
                    reset_at: 4070908800,
                    limit_window_seconds: 604800,
                  },
                },
              },
      };
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: upstream.status, body: encodeJson(upstream.body) }),
      );
    }).pipe(
      Effect.delay(
        request.method === "POST" && request.url.endsWith("/api-call")
          ? (options.redeemDelay ?? 0)
          : 0,
      ),
    ),
  );
  return {
    requests,
    api: makeCliproxyApi.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(NodeCrypto.layer),
    ),
  };
}

const unreachableHub = (
  fail: (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  ) => HttpClientError.HttpClientError,
) =>
  makeCliproxyApi.pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.fail(fail(request))),
    ),
    Effect.provide(NodeCrypto.layer),
  );

describe("CLIProxyAPI hub failures", () => {
  it.effect("names the TLS code when the hub's certificate is not trusted", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              // Node's fetch wraps the TLS error, which carries the code, in a generic TypeError.
              cause: new TypeError("fetch failed", {
                cause: Object.assign(new Error("unable to get local issuer certificate"), {
                  code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
                }),
              }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
      expect(error.detail).toContain("NODE_EXTRA_CA_CERTS");
    }),
  );

  // regression: #18168 Limits hub failures name their TLS, HTTP, or timeout cause
  it.effect("ignores a transport code that is not a short Node error code", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: Object.assign(new Error("odd"), { code: "X".repeat(200) }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toBe("The hub management request failed.");
    }),
  );

  it.effect("names the status, not the body, when the hub rejects the request", () =>
    Effect.gen(function* () {
      const test = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "management-secret is wrong" }, { status: 401 }),
          ),
        ),
      );
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(HttpClient.HttpClient, test),
        Effect.provide(NodeCrypto.layer),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toContain("401");
      expect(error.detail).not.toContain("management-secret");
    }),
  );
});

describe("CLIProxyAPI built-in management API", () => {
  it.effect(
    "reads both accounts and their earliest unexpired credits without plugin endpoints",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1788710400000);
        const test = fixture({ accounts: [{ ...accounts[0]!, label: " Work " }, accounts[1]!] });
        const api = yield* test.api;
        const result = yield* api.readAccounts(config);
        expect(result.map((account) => account.label)).toEqual(["Work", undefined]);
        expect(result.map((account) => account.usageLimits.resetCredits)).toEqual([
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
        ]);
        expect(result[0]?.usageLimits.windows).toMatchObject([
          { id: "secondary", usedPercent: 78, kind: "weekly" },
        ]);
        const calls = test.requests.filter((request) => request.body?.url);
        expect(calls.map((request) => request.body?.auth_index).sort()).toEqual([
          "a",
          "a",
          "b",
          "b",
        ]);
        expect(
          calls.find((request) => request.body?.auth_index === "b")?.body?.header?.[
            "Chatgpt-Account-Id"
          ],
        ).toBe("account-b");
      }),
  );

  it.effect("resolves a missing usage plan from current, then legacy, token plans", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          { ...accounts[0]!, id_token: { chatgpt_account_id: "account-a", plan_type: "free" } },
          {
            ...accounts[1]!,
            id_token: {
              chatgpt_account_id: "account-b",
              plan_type: "go",
              chatgpt_plan_type: "plus",
            },
          },
          {
            ...accounts[1]!,
            id: "third.json",
            auth_index: "c",
            id_token: { chatgpt_account_id: "account-c", chatgpt_plan_type: "free" },
          },
        ],
        upstream: (request) => ({
          status: 200,
          body: {
            ...(request.auth_index === "a" ? { plan_type: "plus" } : {}),
            rate_limit: { primary_window: { used_percent: 12 } },
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result.map((account) => [account.plan, account.usageLimits.windows[0]?.kind])).toEqual(
        [
          ["ChatGPT Plus Subscription", "session"],
          ["ChatGPT Go Subscription", "monthly"],
          ["ChatGPT Free Subscription", "monthly"],
        ],
      );
    }),
  );

  it.effect("keeps the path of a hub served under a prefix", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      yield* api.readAccounts({ ...config, url: "https://tools.test/cliproxy" });
      expect(test.requests.length).toBeGreaterThan(0);
      expect(
        test.requests.every((request) => request.path.startsWith("/cliproxy/v0/management/")),
      ).toBe(true);
    }),
  );

  it.effect("keeps usage when the credits endpoint fails", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.url?.endsWith("rate-limit-reset-credits")
            ? { status: 503, body: { token: "do-not-publish" } }
            : { status: 200, body: { rate_limit: { primary_window: { used_percent: 12 } } } },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(result[0]?.usageLimits.resetCredits).toBeUndefined();
    }),
  );

  it.effect("isolates a failed account and never publishes upstream error bodies", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.auth_index === "a"
            ? { status: 401, body: { token: "do-not-publish" } }
            : {
                status: 200,
                body: request.url?.endsWith("rate-limit-reset-credits")
                  ? { credits: [] }
                  : { rate_limit: { primary_window: { used_percent: 12 } } },
              },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(result[1]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(encodeJson(result)).not.toContain("do-not-publish");
    }),
  );

  it.effect("maps Claude scoped windows and reset credits without a scheduler plugin", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-31T12:00:00Z"));
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        // The hub sets its own client headers.
        upstream: (request) => ({
          status: request.header?.["User-Agent"] === undefined ? 200 : 400,
          body: {
            cedar_ember: {
              eligible: true,
              next_grant_id: "grant_a",
              grants: [
                {
                  id: "grant_a",
                  resets_left: 1,
                  usable_now: true,
                  ends_at: "2099-01-01T00:00:00Z",
                },
                { id: "grant_b", resets_left: 2, usable_now: true },
              ],
            },
            five_hour: { utilization: 10, resets_at: null },
            seven_day: { utilization: 50, resets_at: "2099-01-01T00:00:00Z" },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 80,
                resets_at: null,
                scope: { model: { display_name: "Fable" } },
              },
            ],
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(
        result[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([
        ["five_hour", 10],
        ["seven_day", 50],
        ["seven_day_fable", 80],
      ]);
      expect(result[0]?.usageLimits.resetCredits).toEqual({
        availableCount: 3,
        nextCreditId: "grant_a",
        nextExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(test.requests.find((request) => request.body?.url)?.body?.url).toBe(
        "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
      );
    }),
  );

  it.effect("finds a Claude login only by its exact email and organization", () =>
    Effect.gen(function* () {
      const claude = { ...accounts[0]!, provider: "claude", organization_uuid: "org-1" };
      const login = { email: "FIRST@example.com", organizationId: "org-1" };
      for (const [hubAccounts, expected] of [
        [[{ ...claude, organization_uuid: "org-2" }, claude], "first.json"],
        [[{ ...claude, organization_uuid: "org-2" }], undefined],
        [[{ ...accounts[0]!, provider: "claude" }], undefined],
        [[{ ...claude, disabled: true }], undefined],
        [[claude, { ...claude, id: "copy.json" }], undefined],
      ] as const) {
        const api = yield* fixture({ accounts: [...hubAccounts] }).api;
        expect((yield* api.findClaudeLogin([config], login))?.account.id).toBe(expected);
      }
      const test = fixture({ accounts: [claude] });
      const api = yield* test.api;
      expect(
        yield* api.findClaudeLogin(
          [
            { ...config, enabled: false },
            { ...config, managementKey: "" },
          ],
          login,
        ),
      ).toBeUndefined();
      expect(
        yield* api.findClaudeLogin([config], { ...login, organizationId: undefined }),
      ).toBeUndefined();
      expect(test.requests).toEqual([]);
      const unreadable = yield* Effect.flip(
        (yield* unreachableHub(
          (request) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
        )).findClaudeLogin([config], login),
      );
      expect(unreadable._tag).toBe("UsageLimitSourceError");
    }),
  );

  it.effect("redeems a Claude reset for the account's own organization", () =>
    Effect.gen(function* () {
      const claude = { ...accounts[0]!, provider: "claude", organization_uuid: "org-1" };
      const answer = (status: number, body: unknown) =>
        fixture({ accounts: [claude], upstream: () => ({ status, body }) });
      for (const [status, body, outcome, clearsCooldown] of [
        [200, { result: "reset" }, "reset", true],
        [200, { result: "already_used" }, "alreadyRedeemed", true],
        [200, { result: "not_limited" }, "nothingToReset", false],
        [200, { result: "ineligible" }, "noCredit", false],
      ] as const) {
        const test = answer(status, body);
        expect(yield* (yield* test.api).consume(config, "first.json", "grant_a")).toEqual({
          outcome,
        });
        const redemption = test.requests.find((request) => request.body?.url);
        expect(redemption?.body?.url).toBe(
          "https://api.anthropic.com/api/organizations/org-1/reset_rate_limits",
        );
        expect(redemption?.body?.method).toBe("POST");
        expect(JSON.parse(redemption?.body?.data ?? "")).toEqual({
          program: "cedar_ember",
          grant_id: "grant_a",
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        });
        expect(test.requests.some((request) => request.path.endsWith("/reset-quota"))).toBe(
          clearsCooldown,
        );
      }
      const twice = answer(200, { result: "reset" });
      const api = yield* twice.api;
      yield* api.consume(config, "first.json", "grant_a");
      yield* api.consume(config, "first.json", "grant_a");
      const requestIds = twice.requests.flatMap((request) =>
        request.body?.data ? [JSON.parse(request.body.data).request_id] : [],
      );
      expect(new Set(requestIds).size).toBe(2);
      for (const [status, body, detail] of [
        [200, { result: "cooldown" }, "Claude resets are cooling down. Try again later."],
        [
          200,
          { result: "unavailable" },
          "Claude could not confirm the reset. If you are still limited in a moment, try again.",
        ],
        [429, {}, "Claude is rate limiting resets. Try again soon."],
        [403, { error: "organization mismatch" }, "Sign in to Claude again to redeem resets."],
        [502, {}, "Claude could not redeem the reset."],
      ] as const) {
        const test = answer(status, body);
        const error = yield* Effect.flip(
          (yield* test.api).consume(config, "first.json", "grant_a"),
        );
        expect(error.detail).toBe(detail);
        expect(test.requests.some((request) => request.path.endsWith("/reset-quota"))).toBe(false);
      }
    }),
  );

  it.effect("waits longer for a redeem than for a read", () =>
    Effect.gen(function* () {
      const claude = { ...accounts[0]!, provider: "claude", organization_uuid: "org-1" };
      for (const account of [accounts[0]!, claude]) {
        const api = yield* fixture({
          accounts: [account],
          upstream: (request) => ({
            status: 200,
            body: request.url?.endsWith("/consume") ? { code: "reset" } : { result: "reset" },
          }),
          redeemDelay: "29 seconds",
        }).api;
        const redeem = yield* Effect.forkChild(api.consume(config, "first.json", "grant_a"));
        yield* TestClock.adjust("29 seconds");
        expect((yield* Fiber.join(redeem)).outcome).toBe("reset");
      }
    }),
  );

  it.effect("refuses a Claude redemption without an organization or with a malformed grant", () =>
    Effect.gen(function* () {
      for (const [account, grantId] of [
        [{ ...accounts[0]!, provider: "claude" }, "grant_a"],
        [{ ...accounts[0]!, provider: "claude", organization_uuid: " " }, "grant_a"],
        [{ ...accounts[0]!, provider: "claude", organization_uuid: "org-1" }, "Bad Grant"],
      ] as const) {
        const test = fixture({ accounts: [account] });
        const result = yield* (yield* test.api)
          .consume(config, "first.json", grantId)
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(test.requests.every((request) => request.path.endsWith("/auth-files"))).toBe(true);
      }
    }),
  );

  it.effect("pins redemption to the displayed credit and clears only that account's cooldown", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      const redemptions = test.requests.filter((request) =>
        request.body?.url?.endsWith("/consume"),
      );
      expect(redemptions).toHaveLength(2);
      expect(redemptions[0]?.body?.data).toBe(redemptions[1]?.body?.data);
      expect(redemptions[0]?.body?.data).toBe(
        encodeJson({
          redeem_request_id: "519d5243-011a-5b7b-91f3-44d85f095705",
          credit_id: "credit-b",
        }),
      );
      expect(
        test.requests
          .filter((request) => request.path.endsWith("/reset-quota"))
          .map((request) => request.body?.auth_index),
      ).toEqual(["b", "b"]);
    }),
  );

  it.effect("reports redemption success even if cooldown clearing fails", () =>
    Effect.gen(function* () {
      const api = yield* fixture({ cooldownStatus: 404 }).api;
      const result = yield* api.consume(config, "first.json", "credit");
      expect(result.outcome).toBe("reset");
      expect(result.warning).toContain("cooldown");
    }),
  );

  it.effect("skips disabled accounts and rejects redemption on them", () =>
    Effect.gen(function* () {
      const test = fixture({ accounts: [{ ...accounts[0]!, disabled: true }] });
      const api = yield* test.api;
      expect(yield* api.readAccounts(config)).toEqual([]);
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(test.requests.every((request) => request.path.endsWith("/auth-files"))).toBe(true);
    }),
  );

  it.effect("keeps the same redemption id after an uncertain upstream failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const test = fixture({
        upstream: () =>
          ++attempts === 1
            ? { status: 503, body: {} }
            : { status: 200, body: { code: "already_redeemed" } },
      });
      const api = yield* test.api;
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({
        outcome: "alreadyRedeemed",
      });
      const data = test.requests
        .filter((request) => request.body?.url?.endsWith("/consume"))
        .map((request) => request.body?.data);
      expect(data[0]).toBe(data[1]);
      expect(test.requests.filter((request) => request.path.endsWith("/reset-quota"))).toHaveLength(
        1,
      );
    }),
  );

  it.effect("rejects unknown accounts without forwarding a redemption", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      const result = yield* api.consume(config, "missing.json", "credit").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.requests).toHaveLength(1);
    }),
  );
});
