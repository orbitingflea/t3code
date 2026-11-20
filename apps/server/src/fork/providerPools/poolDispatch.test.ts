import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";

const id = ProviderInstanceId.make;
const claude = ProviderDriverKind.make("claudeAgent");
const projectId = ProjectId.make("project:pool-dispatch");
const threadId = ThreadId.make("thread:pool-dispatch");

const layerWith = (dispatched: Array<OrchestrationV2ServerCommand>) =>
  ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: {
              id: threadId,
              projectId,
              deletedAt: null,
              modelSelection: { instanceId: id("codex"), model: "gpt" },
            },
          } as unknown as OrchestrationV2ThreadProjection),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 1, storedEvents: [] } as never;
          }),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: {
          [id("claude_a")]: { driver: claude },
          [id("claude_b")]: { driver: claude },
          [id("claude_off")]: { driver: claude, enabled: false },
        },
        providerPools: { claude_auto: { members: ["claude_a", "claude_b"] } },
      }),
    ),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  );

const switchingMessage = (instanceId: string): OrchestrationV2ServerCommand => ({
  type: "message.dispatch",
  commandId: CommandId.make(`command:pool-dispatch:${instanceId}`),
  threadId,
  messageId: MessageId.make(`message:pool-dispatch:${instanceId}`),
  text: "Continue on the pool.",
  attachments: [],
  dispatchMode: { type: "queue_after_active" },
  modelSelection: { instanceId: id(instanceId), model: "opus" },
  createdBy: "user",
  creationSource: "web",
});

it.effect(
  "thread management hands a message that switches to a pool to the orchestrator to place",
  () => {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch(switchingMessage("claude_auto"));
      assert.deepStrictEqual(
        dispatched.map((command) => command.commandId),
        ["command:pool-dispatch:claude_auto"],
      );

      const error = yield* threads.dispatch(switchingMessage("claude_off")).pipe(Effect.flip);
      assert.instanceOf(
        error,
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      assert.strictEqual(dispatched.length, 1);
    }).pipe(Effect.provide(layerWith(dispatched)));
  },
);
