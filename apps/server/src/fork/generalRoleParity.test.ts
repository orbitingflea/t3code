import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { PeerForwarding } from "../peer/PeerForwarding.ts";
import { PeerLinkRequests } from "../peer/PeerLinkRequests.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { PreviewBrowser } from "../preview/PreviewBrowser.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { ProjectCloneTracker } from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.ts";
import { DocumentText } from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { PullRequestReviewGuideService } from "../pullRequest/PullRequestReviewGuideService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";

const instanceId = ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID;
const projectId = ProjectId.make("project:general-role-parity");
const task = "Reply OK.";
const claudeSettings = Schema.decodeSync(ClaudeSettings)({});
const title = "Parity check";

// The model and runtime mode a person picks for a sidebar thread. The parent thread uses them too.
// Both take them from this constant, so the comparison does not depend on settings from elsewhere.
const sidebar = { model: "claude-opus-5-5", runtimeMode: "full-access" } as const;

const claudeProvider: ServerProvider = {
  instanceId,
  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-04T00:00:00.000Z",
  models: BUNDLED_CLAUDE_MODEL_CATALOG.models.map((entry) => entry.model),
  slashCommands: [],
  skills: [],
};

interface FirstRequest {
  readonly options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
  readonly message: SDKUserMessage;
}

// The session, message and token fields differ between any two threads. The cache TTL is left out
// because only a child takes it from the subagentPromptCacheTtl setting. The rest must match.
const withoutNoise = ({ options, message }: FirstRequest) => {
  const {
    sessionId: _sessionId,
    resume: _resume,
    env,
    mcpServers,
    canUseTool,
    onUserDialog,
    onElicitation,
    ...rest
  } = options as ClaudeAdapterV2.ClaudeAgentSdkQueryOptions & Record<string, unknown>;
  const { CLAUDE_CODE_PROMPT_CACHE_TTL: _ttl, ...environment } = env ?? {};
  const { uuid: _uuid, session_id: _session, ...userMessage } = message;
  return {
    options: {
      ...rest,
      env: environment,
      mcpServers: Object.fromEntries(
        Object.entries(mcpServers ?? {}).map(([name, server]) => [
          name,
          "headers" in server
            ? { ...server, headers: { ...server.headers, Authorization: "token" } }
            : server,
        ]),
      ),
      callbacks: [canUseTool, onUserDialog, onElicitation].map((callback) => typeof callback),
    },
    message: userMessage,
  };
};

const runParity = (input: {
  readonly effort: string;
  readonly delegateTarget: "inherit" | "explicit";
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("general-role-parity");
      const modelSelection: ModelSelection = {
        instanceId,
        model: sidebar.model,
        options: [{ id: "effort", value: input.effort }],
      };
      const opened = yield* Queue.unbounded<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput>();
      const offered = yield* Queue.unbounded<SDKUserMessage>();
      const fileSystem = yield* FileSystem.FileSystem;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-general-role-parity-",
      });
      let sessions = 0;
      const layerAdapters = ProviderAdapterRegistry.layerFromAdaptersEffect(
        Effect.gen(function* () {
          return [
            yield* ClaudeAdapterV2.makeClaudeAdapterV2({
              instanceId,
              settings: claudeSettings,
              environment: {},
              attachmentsDir,
              fileSystem,
              path: yield* Path.Path,
              random: yield* SecureRandom.SecureRandom,
              idAllocator: yield* IdAllocator.IdAllocatorV2,
              queryRunner: {
                allocateSessionId: Effect.sync(() => `native-session-${++sessions}`),
                open: (open) =>
                  Queue.offer(opened, open).pipe(
                    Effect.as({
                      messages: Stream.never,
                      offer: (message: SDKUserMessage) => Queue.offer(offered, message),
                      setModel: () => Effect.void,
                      applyFlagSettings: () => Effect.void,
                      setPermissionMode: () => Effect.void,
                      backgroundTasks: () => Effect.succeed(false),
                      stopTask: () => Effect.void,
                      interrupt: Effect.void,
                      close: Effect.void,
                    }),
                  ),
                forkSession: () => Effect.die("unused"),
                subagentLaunchToolUseId: () => Effect.succeed(null),
                assertComplete: Effect.void,
              },
            }),
          ];
        }).pipe(
          Effect.provide(Layer.mergeAll(IdAllocator.layer, NodeServices.layer, NodeCrypto.layer)),
        ),
      ).pipe(Layer.provide(McpProviderSessions.layer));
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name: "general-role-parity" },
        layerAdapters,
        { runEffectWorker: false, configureMcp: true },
      );
      const layerOrchestration = Layer.merge(
        layerOrchestrator,
        ThreadManagementService.layer.pipe(
          Layer.provide(layerOrchestrator),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        ),
      );
      const layerTest = OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provideMerge(layerOrchestration),
        Layer.provide(
          Layer.mergeAll(
            layerAdapters,
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([claudeProvider]),
              refreshInstance: () => Effect.succeed([claudeProvider]),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            ServerSettings.layerTest(),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      );

      return yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const firstRequest = (threadId: ThreadId) =>
          Effect.gen(function* () {
            yield* worker.drain();
            const open = yield* Queue.take(opened);
            expect(open.threadId).toBe(threadId);
            return { options: open.options, message: yield* Queue.take(offered) };
          });
        // The sidebar path: the web client creates the thread, then sends the typed text.
        const startFromSidebar = (threadId: ThreadId, text: string) =>
          Effect.gen(function* () {
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`create:${threadId}`),
              threadId,
              projectId,
              title,
              modelSelection,
              runtimeMode: sidebar.runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`send:${threadId}`),
              threadId,
              messageId: MessageId.make(`message:${threadId}`),
              text,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            return yield* firstRequest(threadId);
          });

        const botThreadId = ThreadId.make("thread:bot");
        yield* startFromSidebar(botThreadId, "Start a worker.");
        const sidebarRequest = yield* startFromSidebar(ThreadId.make("thread:sidebar"), task);

        const scope: McpThreadInvocationScope = {
          environmentId: EnvironmentId.make("environment:general-role-parity"),
          requestNamespace: "provider-session:bot",
          thread: {
            threadId: botThreadId,
            providerSessionId: "provider-session:bot",
            providerInstanceId: instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const delegated = yield* service.delegateTask(scope, {
          task,
          title,
          role: "general",
          ...(input.delegateTarget === "explicit"
            ? {
                target: {
                  providerInstanceId: instanceId,
                  model: sidebar.model,
                  options: [{ id: "effort", value: input.effort }],
                },
              }
            : {}),
        });
        const childRequest = yield* firstRequest(delegated.childThreadId!);
        const child = yield* orchestrator.getThreadProjection(delegated.childThreadId!);
        return { sidebarRequest, childRequest, child };
      }).pipe(Effect.provide(layerTest));
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.effect.each([
  { effort: "medium", delegateTarget: "inherit" },
  { effort: "high", delegateTarget: "inherit" },
  { effort: "medium", delegateTarget: "explicit" },
  { effort: "high", delegateTarget: "explicit" },
] as const)(
  "a general child's first Claude request matches a sidebar thread's (effort $effort, $delegateTarget target)",
  (input) =>
    Effect.gen(function* () {
      const { sidebarRequest, childRequest, child } = yield* runParity(input);

      expect(child.thread.lineage.relationshipToParent).toBe("subagent");
      expect(sidebarRequest.options.effort).toBe(input.effort);
      const { systemPrompt } = sidebarRequest.options;
      expect(
        typeof systemPrompt === "object" && "append" in systemPrompt && systemPrompt.append,
      ).toContain(T3_CODE_ORCHESTRATION_INSTRUCTIONS);
      expect(withoutNoise(childRequest)).toEqual(withoutNoise(sidebarRequest));
    }),
);

// Serving tools/list only reads registrations, so the handlers' services are never called.
const toolHandlerServices = Layer.mergeAll(
  Layer.mock(DeviceService)({}),
  Layer.mock(DocumentText)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(GitWorkflowService)({}),
  Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "" }),
  Layer.mock(McpProviderSessions.McpProviderSessions)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(PeerForwarding)({}),
  Layer.mock(PeerLinkRequests)({}),
  Layer.mock(PeerLinks)({}),
  Layer.mock(PreviewAutomationBroker)({}),
  Layer.mock(PreviewBrowser)({}),
  Layer.mock(PreviewManager)({}),
  Layer.mock(ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService)({}),
  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-general-role-parity-" }),
  Layer.mock(ServerEnvironment)({}),
  Layer.mock(ServerSecretStore)({}),
  ServerSettings.layerTest(),
  Layer.mock(SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  McpToolAccessTestkit.liveThreadsLayer,
  Layer.mock(ThreadSearch)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const decodeToolsList = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          description: Schema.optional(Schema.String),
          inputSchema: Schema.Unknown,
        }),
      ),
    }),
  }),
);

it.effect(
  "a delegated child lists every T3 MCP tool a sidebar thread does, but the two PR watch tools",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scopeFor = (token: string, subagent: boolean): McpThreadInvocationScope => ({
          environmentId: EnvironmentId.make("environment:general-role-parity"),
          requestNamespace: token,
          thread: {
            threadId: ThreadId.make(`thread-${token}`),
            providerSessionId: token,
            providerInstanceId: instanceId,
            subagent,
          },
          client: undefined,
          capabilities: new Set([
            "preview",
            "orchestration",
            "worktree",
            "device",
            "pull-requests",
          ]),
          issuedAt: 1,
        });
        const scopes = new Map([
          ["sidebarToken", scopeFor("sidebarToken", false)],
          ["childToken", scopeFor("childToken", true)],
        ]);
        const serverLayer = McpHttpServer.layerMcpTransport(McpHttpServer.layerTools).pipe(
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) => Effect.succeed(scopes.get(token)),
            }),
          ),
          Layer.provide(toolHandlerServices),
        );
        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );
        const httpClient = yield* HttpClient.HttpClient;
        const listedTools = (token: string) =>
          Effect.gen(function* () {
            const headers = {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${token}`,
            };
            const initialize = yield* httpClient.post("/mcp", {
              headers,
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
                "application/json",
              ),
            });
            const listed = yield* httpClient.post("/mcp", {
              headers: {
                ...headers,
                "mcp-session-id": initialize.headers["mcp-session-id"]!,
                "mcp-protocol-version": "2025-06-18",
              },
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
                "application/json",
              ),
            });
            const body = yield* decodeToolsList(yield* listed.json);
            return new Map(
              body.result.tools.map(({ name, description, inputSchema }) => [
                name,
                { name, description, inputSchema },
              ]),
            );
          });

        const sidebarTools = yield* listedTools("sidebarToken");
        const childTools = yield* listedTools("childToken");
        expect(sidebarTools.has("delegate_task")).toBe(true);
        expect([...sidebarTools.keys()].filter((name) => !childTools.has(name)).toSorted()).toEqual(
          ["unwatch_pull_request", "watch_pull_request"],
        );
        expect([...childTools.values()]).toEqual(
          [...sidebarTools.values()].filter((tool) => childTools.has(tool.name)),
        );
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
