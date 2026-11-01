import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type ClaudeSettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import { ClaudeDriver } from "../../provider/Drivers/ClaudeDriver.ts";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import { makeProviderInstanceRegistry } from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderHostLive from "../../provider/ProviderHostLive.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "../../provider/ProviderOrchestrationAdapterInfrastructure.ts";
import * as ResetCreditCoordinator from "../../provider/resetCreditCoordinator.ts";
import * as ServerSettings from "../../serverSettings.ts";

// The mock Claude CLI is a script Windows cannot execute.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const decodeHubCall = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
);

const layerTest = ProviderOrchestrationAdapterInfrastructure.layer.pipe(
  Layer.provide(PortScanner.layerTest),
  Layer.provideMerge(ProviderHostLive.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "claude-login-source-test" }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ServerSettings.layerTest()),
      Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
      Layer.provideMerge(Layer.mock(SecretResolver.SecretResolver)({})),
      Layer.provideMerge(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(
            EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
          ),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(true),
          shouldRunOpportunisticWork: Effect.succeed(true),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
      Layer.provideMerge(ProviderLatestVersions.layer),
      Layer.provideMerge(McpProviderSessions.layer),
      Layer.provideMerge(ModelManifest.layerTest),
      Layer.provideMerge(ResetCreditCoordinator.layerTest),
    ),
  ),
);

const redeemClaudeReset = (claim: {
  usageSourceOnly?: boolean;
  hub?: {
    accounts: ReadonlyArray<{ email: string; organization_uuid?: string }>;
    listStatus?: number;
    usageStatus?: number;
  };
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtureDir = yield* fs.makeTempDirectoryScoped();
    const claudePath = path.join(fixtureDir, "claude");
    const claudeHomePath = path.join(fixtureDir, "claude-home");
    yield* fs.copyFile(
      yield* path.fromFileUrl(
        new URL("../../provider/testing/ProviderInstanceRegistryLive.fixture.mjs", import.meta.url),
      ),
      claudePath,
    );
    yield* fs.chmod(claudePath, 0o755);
    yield* fs.makeDirectory(claudeHomePath);
    const marker = path.join(claudeHomePath, "redeemed");
    yield* fs.writeFileString(
      path.join(claudeHomePath, ".credentials.json"),
      '{"claudeAiOauth":{"accessToken":"fake-token"}}',
    );
    yield* fs.writeFileString(
      path.join(claudeHomePath, ".claude.json"),
      '{"oauthAccount":{"emailAddress":"test@example.com","organizationUuid":"fake-org"}}',
    );
    const direct: Array<string> = [];
    const viaHub: Array<string> = [];
    let hubRedeemed = false;
    const credits = {
      eligible: true,
      next_grant_id: "grant_a",
      grants: [{ id: "grant_a", resets_left: 1, usable_now: true }],
    };
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const json = (body: unknown, status = 200) =>
          HttpClientResponse.fromWeb(request, Response.json(body, { status }));
        const url = new URL(request.url);
        if (claim.hub && url.host === "hub.test") {
          if (url.pathname.endsWith("/auth-files")) {
            viaHub.push("auth-files");
            return json(
              {
                files: claim.hub.accounts.map((account, index) => ({
                  id: `${index}.json`,
                  auth_index: `${index}`,
                  provider: "claude",
                  ...account,
                })),
              },
              claim.hub.listStatus,
            );
          }
          if (url.pathname.endsWith("/reset-quota")) {
            viaHub.push("reset-quota");
            return json({});
          }
          const call = decodeHubCall(
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
          );
          viaHub.push(call.url);
          if (call.url.endsWith("/reset_rate_limits")) {
            hubRedeemed = true;
            return json({ status_code: 200, body: JSON.stringify({ result: "reset" }) });
          }
          return json({
            status_code: claim.hub.usageStatus ?? 200,
            body: JSON.stringify({
              five_hour: { utilization: hubRedeemed ? 0 : 100, resets_at: null },
              cedar_ember: credits,
            }),
          });
        }
        if (url.host === "api.anthropic.com") direct.push(url.pathname);
        if (request.url.endsWith("/api/oauth/usage")) return json({ cedar_ember: credits });
        if (request.url.endsWith("/reset_rate_limits")) {
          yield* fs.writeFileString(marker, "redeemed").pipe(Effect.orDie);
          return json({ result: "reset" });
        }
        return json({ version: "0.0.0" });
      }),
    );
    const instanceId = ProviderInstanceId.make("claude_reset");
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [ClaudeDriver],
      configMap: {
        [instanceId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          environment: [
            { name: "T3_CLAUDE_RESET_MARKER", value: marker, sensitive: false },
            ...(claim.usageSourceOnly
              ? [{ name: "T3CODE_CLAUDE_USAGE_SOURCE_ONLY", value: "1", sensitive: false }]
              : []),
          ],
          config: {
            enabled: true,
            binaryPath: claudePath,
            homePath: claudeHomePath,
            customModels: [],
            launchArgs: "",
            autoCompactWindow: "",
            idleCompaction: "default",
          } satisfies ClaudeSettings,
        },
      },
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(
        ServerSettings.layerTest(
          claim.hub
            ? {
                usageLimitSources: {
                  [UsageLimitSourceId.make("hub")]: {
                    kind: "cliproxy",
                    url: "http://hub.test",
                    managementKey: "hub-key",
                    enabled: true,
                  },
                },
              }
            : {},
        ),
      ),
    );
    const instance = yield* registry.getInstance(instanceId);
    expect(instance).toBeDefined();
    const before = yield* instance!.snapshot.refresh;
    const outcome = yield* instance!.consumeResetCredit!().pipe(Effect.result);
    return { before, outcome, after: yield* instance!.snapshot.getSnapshot, direct, viaHub };
  }).pipe(
    // macOS logins live in the Keychain, where resets are never read.
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(layerTest),
  );

describe("Claude logins held by a usage source", () => {
  it.live.skipIf(windowsHost)("reads Claude directly when no usage source holds the login", () =>
    Effect.gen(function* () {
      const { before, outcome, after, direct, viaHub } = yield* redeemClaudeReset({
        hub: {
          accounts: [
            { email: "test@example.com", organization_uuid: "other-org" },
            { email: "test@example.com" },
          ],
        },
      });
      expect(before.usageLimits?.windows[0]?.usedPercent).toBe(100);
      expect(before.usageLimits?.resetCredits?.nextCreditId).toBe("grant_a");
      expect(outcome).toMatchObject({ _tag: "Success", success: "reset" });
      expect(after.usageLimits?.windows[0]?.usedPercent).toBe(0);
      expect(direct).toContain("/api/organizations/fake-org/reset_rate_limits");
      expect(viaHub.every((call) => call === "auth-files")).toBe(true);
    }),
  );

  it.live.skipIf(windowsHost)("reads and redeems the login only through that source", () =>
    Effect.gen(function* () {
      const { before, outcome, after, direct, viaHub } = yield* redeemClaudeReset({
        hub: { accounts: [{ email: "TEST@example.com", organization_uuid: "fake-org" }] },
      });
      expect(before.usageLimits?.windows[0]?.usedPercent).toBe(100);
      expect(before.usageLimits?.resetCredits?.nextCreditId).toBe("grant_a");
      expect(outcome).toMatchObject({ _tag: "Success", success: "reset" });
      expect(after.usageLimits?.windows[0]?.usedPercent).toBe(0);
      expect(direct).toEqual([]);
      expect(viaHub).toContain(
        "https://api.anthropic.com/api/organizations/fake-org/reset_rate_limits",
      );
      expect(viaHub).toContain("reset-quota");
    }),
  );

  it.live.skipIf(windowsHost)(
    "never reads Claude directly for a login no source holds when sources are required",
    () =>
      Effect.gen(function* () {
        for (const hub of [undefined, { accounts: [{ email: "test@example.com" }] }]) {
          const { before, outcome, direct } = yield* redeemClaudeReset({
            usageSourceOnly: true,
            ...(hub ? { hub } : {}),
          });
          expect(before.usageLimits?.unavailable).toMatchObject({
            reason: "probeFailed",
            message: "No usage source holds this Claude login.",
          });
          expect(outcome).toMatchObject({ _tag: "Success", success: "noCredit" });
          expect(direct).toEqual([]);
        }
      }),
  );

  it.live.skipIf(windowsHost)("shows a usage source failure instead of reading Claude", () =>
    Effect.gen(function* () {
      for (const failure of [{ usageStatus: 503 }, { listStatus: 500 }]) {
        const { before, outcome, direct } = yield* redeemClaudeReset({
          hub: {
            accounts: [{ email: "test@example.com", organization_uuid: "fake-org" }],
            ...failure,
          },
        });
        expect(before.usageLimits?.unavailable).toMatchObject({
          reason: "probeFailed",
          message: expect.any(String),
        });
        expect(before.usageLimits?.resetCredits).toBeUndefined();
        expect(outcome).toMatchObject({ _tag: "Success", success: "noCredit" });
        expect(direct).toEqual([]);
      }
    }),
  );
});
