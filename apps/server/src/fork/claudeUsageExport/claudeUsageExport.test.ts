import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeClaudeUsageExport } from "./claudeUsageExport.ts";

const URL_ = "https://usage.example.com/push?source=test";
const KEY = "test-key";
const HOME = "/home/user/.claude";
const RECEIVED_AT = Date.parse("2026-11-03T14:21:07Z");

// A real rate_limit_event from a provider log, ids replaced.
const realEvent = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed_warning",
    resetsAt: 1794272400,
    rateLimitType: "seven_day",
    utilization: 0.28,
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false,
    unifiedWindows: {
      seven_day: { utilization: 0.28, resetsAt: 1794272400, status: "allowed" },
    },
    overageEnabled: true,
  },
  uuid: "00000000-0000-4000-8000-0000000000aa",
  session_id: "00000000-0000-4000-8000-0000000000bb",
} as const;

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

type Reply = (call: Call) => Promise<Response>;

const ok: Reply = async () => new Response('{"status":"queued"}', { status: 202 });

const fakeFetch = Effect.fn(function* (reply: Reply = ok) {
  const calls: Array<Call> = [];
  const called = yield* Queue.unbounded<Call>();
  const settled = yield* Queue.unbounded<Call>();
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    Queue.offerUnsafe(called, call);
    return reply(call).finally(() => Queue.offerUnsafe(settled, call));
  }) as typeof globalThis.fetch;
  return {
    calls,
    fetch,
    nextCall: Queue.take(called),
    nextSettled: Queue.take(settled),
  };
});

// Gives a forked send the turns it needs to reach fetch, so "no call" means none was made.
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));

const run = (
  fetch: typeof globalThis.fetch,
  environment: NodeJS.ProcessEnv = {
    T3CODE_CLAUDE_USAGE_EXPORT_URL: URL_,
    T3CODE_CLAUDE_USAGE_EXPORT_KEY: KEY,
  },
) => {
  const exportEvent = makeClaudeUsageExport({ ...environment });
  return (home: string, rateLimitInfo: unknown) =>
    exportEvent(home, rateLimitInfo).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
};

const bodyOf = (call: Call): unknown => JSON.parse(String(call.init.body));

describe("claude usage event export", () => {
  it.effect("posts the protocol body with the configured URL and Bearer key", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(RECEIVED_AT);
      const http = yield* fakeFetch();
      yield* run(http.fetch)(HOME, realEvent.rate_limit_info);
      const call = yield* http.nextCall;

      expect(call.url).toBe(URL_);
      expect(call.init.method).toBe("POST");
      const headers = new Headers(call.init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
      expect(headers.get("content-type")).toContain("application/json");
      expect(bodyOf(call)).toEqual({
        v: 1,
        kind: "claude.rate_limit",
        at: "2026-11-03T14:21:07.000Z",
        home: HOME,
        rate_limit_info: realEvent.rate_limit_info,
      });
      const raw = String(call.init.body);
      expect(raw).not.toContain(realEvent.uuid);
      expect(raw).not.toContain(realEvent.session_id);
      expect(raw).not.toContain(KEY);
    }),
  );

  it.live("keeps the URL and key for the export and out of processes the server starts", () =>
    Effect.gen(function* () {
      const environment: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        T3CODE_CLAUDE_USAGE_EXPORT_URL: URL_,
        T3CODE_CLAUDE_USAGE_EXPORT_KEY: KEY,
      };
      const exportEvent = makeClaudeUsageExport(environment);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const inherited = (yield* spawner.string(
        ChildProcess.make(
          process.execPath,
          ["-e", "process.stdout.write(Object.keys(process.env).join('\\n'))"],
          { env: environment },
        ),
      )).split("\n");
      expect(inherited).toContain("PATH");
      expect(inherited).not.toContain("T3CODE_CLAUDE_USAGE_EXPORT_URL");
      expect(inherited).not.toContain("T3CODE_CLAUDE_USAGE_EXPORT_KEY");

      const http = yield* fakeFetch();
      yield* exportEvent(HOME, realEvent.rate_limit_info).pipe(
        Effect.provideService(FetchHttpClient.Fetch, http.fetch),
      );
      const call = yield* http.nextCall;
      expect(call.url).toBe(URL_);
      expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sends nothing without unifiedWindows or for an unknown shape", () =>
    Effect.gen(function* () {
      const http = yield* fakeFetch();
      const exportEvent = run(http.fetch);
      yield* exportEvent(HOME, { status: "allowed", isUsingOverage: false });
      yield* exportEvent(HOME, { status: "allowed", unifiedWindows: {} });
      yield* exportEvent(HOME, { status: "allowed", unifiedWindows: { seven_day: 0.28 } });
      yield* exportEvent(HOME, {
        status: "allowed",
        unifiedWindows: { seven_day: { utilization: "28%", resetsAt: 1794272400 } },
      });
      yield* exportEvent(HOME, { unifiedWindows: realEvent.rate_limit_info.unifiedWindows });
      yield* exportEvent(HOME, "allowed");
      yield* exportEvent(HOME, null);
      yield* settle;

      expect(http.calls).toHaveLength(0);
    }),
  );

  it.effect("sends nothing over 4 KiB", () =>
    Effect.gen(function* () {
      const http = yield* fakeFetch();
      yield* run(http.fetch)(HOME, {
        ...realEvent.rate_limit_info,
        overageDisabledReason: "x".repeat(4096),
      });
      yield* settle;

      expect(http.calls).toHaveLength(0);
    }),
  );

  it.effect("sends the same home and numbers once in 60 s", () =>
    Effect.gen(function* () {
      const http = yield* fakeFetch();
      const exportEvent = run(http.fetch);
      const info = realEvent.rate_limit_info;
      const changed = {
        ...info,
        unifiedWindows: { seven_day: { ...info.unifiedWindows.seven_day, utilization: 0.29 } },
      };
      const otherHome = "/home/user/.claude-2";

      yield* exportEvent(HOME, info);
      yield* http.nextCall;
      yield* TestClock.adjust("59 seconds");
      yield* exportEvent(HOME, structuredClone(info));
      yield* settle;
      expect(http.calls).toHaveLength(1);

      yield* exportEvent(HOME, changed);
      expect(bodyOf(yield* http.nextCall)).toMatchObject({ rate_limit_info: changed });
      yield* exportEvent(otherHome, info);
      expect(bodyOf(yield* http.nextCall)).toMatchObject({ home: otherHome });

      yield* TestClock.adjust("1 second");
      yield* exportEvent(HOME, info);
      expect(bodyOf(yield* http.nextCall)).toMatchObject({ home: HOME, rate_limit_info: info });
      yield* settle;
      expect(http.calls).toHaveLength(4);
    }),
  );

  it.effect("sends nothing when the URL is unset", () =>
    Effect.gen(function* () {
      const http = yield* fakeFetch();
      yield* run(http.fetch, { T3CODE_CLAUDE_USAGE_EXPORT_KEY: KEY })(
        HOME,
        realEvent.rate_limit_info,
      );
      yield* run(http.fetch, { T3CODE_CLAUDE_USAGE_EXPORT_URL: " " })(
        HOME,
        realEvent.rate_limit_info,
      );
      yield* settle;

      expect(http.calls).toHaveLength(0);
    }),
  );

  it.effect("gives up on a slow endpoint after 2 s without retry or blocking", () =>
    Effect.gen(function* () {
      const http = yield* fakeFetch(
        ({ init }) =>
          new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const caller = yield* Effect.forkChild(run(http.fetch)(HOME, realEvent.rate_limit_info));
      const call = yield* http.nextCall;
      expect(caller.pollUnsafe()?._tag).toBe("Success");

      yield* TestClock.adjust("1999 millis");
      yield* settle;
      expect(call.init.signal?.aborted).toBe(false);
      yield* TestClock.adjust("1 millis");
      yield* settle;
      expect(call.init.signal?.aborted).toBe(true);
      yield* TestClock.adjust("10 seconds");
      yield* settle;
      expect(http.calls).toHaveLength(1);
    }),
  );

  it.effect("does not retry or fail on 4xx, 5xx or a failing endpoint", () =>
    Effect.gen(function* () {
      const replies: Array<Reply> = [
        async () => new Response('{"error":"unauthorized"}', { status: 401 }),
        async () => new Response('{"error":"internal error"}', { status: 500 }),
        async () => {
          throw new TypeError("fetch failed");
        },
      ];
      for (const reply of replies) {
        const http = yield* fakeFetch(reply);
        const result = yield* Effect.exit(run(http.fetch)(HOME, realEvent.rate_limit_info));
        yield* http.nextSettled;
        yield* TestClock.adjust("10 seconds");
        yield* settle;

        expect(result._tag).toBe("Success");
        expect(http.calls).toHaveLength(1);
      }
    }),
  );
});
