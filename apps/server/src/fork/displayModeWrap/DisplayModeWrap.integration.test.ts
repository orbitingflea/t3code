import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ProviderReplayTranscript } from "@t3tools/contracts";
import { MESSAGES_ONLY_DISPLAY_MODE } from "@t3tools/shared/displayModes";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ClaudeOrchestratorReplayHarness } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import { multiTurnInput } from "../../orchestration-v2/testkit/fixtures/multi_turn/input.ts";
import {
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  type OrchestratorFixtureInput,
  projectionFor,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  TURN_INTERRUPT_RECOVERY_PROMPT,
} from "../../orchestration-v2/testkit/fixtures/shared.ts";
import { turnInterruptRestartInput } from "../../orchestration-v2/testkit/fixtures/turn_interrupt_restart/input.ts";
import { runOrchestratorV2ProviderReplayScenario } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as DisplayModeWrap from "./DisplayModeWrap.ts";
import { layerNoProviders } from "./DisplayModeWrap.testkit.ts";

const wrappedPrompt = (earlier: string, text: string) =>
  [
    "<t3-messages-mode>",
    "This message is from the user. Before it, their screen showed:",
    `[user] ${earlier}`,
    "</t3-messages-mode>",
    text,
  ].join("\n");

const told = (text: string) => `${MESSAGES_ONLY_DISPLAY_MODE.notice}\n${text}`;

// The replay fails unless each prompt the adapter sends matches the transcript exactly.
const expectPrompts = (
  transcript: ProviderReplayTranscript,
  prompts: Readonly<Record<string, string>>,
): ProviderReplayTranscript => ({
  ...transcript,
  entries: transcript.entries.map((entry) => {
    const text =
      entry.type === "expect_outbound" && entry.label !== undefined
        ? prompts[entry.label]
        : undefined;
    return text !== undefined
      ? {
          ...entry,
          frame: {
            type: "prompt.offer",
            message: {
              type: "user",
              message: { role: "user", content: text },
              parent_tool_use_id: null,
            },
          },
        }
      : entry;
  }),
});

const runTwoPrompts = Effect.fn("runTwoPrompts")(function* (input: {
  readonly scenario: string;
  readonly fixtureInput: OrchestratorFixtureInput;
  readonly displayMode: string | undefined;
  /** The prompts that the provider gets, by transcript label, where they differ from the recording. */
  readonly prompts: Readonly<Record<string, string>>;
}) {
  const recorded = yield* readProviderReplayTranscript(
    new URL(
      `../../orchestration-v2/testkit/fixtures/${input.scenario}/claude_transcript.ndjson`,
      import.meta.url,
    ),
  ).pipe(Effect.provide(NodeServices.layer));
  const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
    materializeReplayTranscriptRuntimeInstructions(expectPrompts(recorded, input.prompts), {
      driver: ProviderDriverKind.make("claudeAgent"),
      model: CLAUDE_MODEL_SELECTION.model,
    }),
  );
  const { fixtureInput } = input;
  const workspace = yield* checkpointWorkspace(input.scenario, fixtureInput.workspaceFiles);
  const materialized = yield* materializeFixtureInput({
    scenario: input.scenario,
    fixtureInput,
    driver: ProviderDriverKind.make("claudeAgent"),
    modelSelection: CLAUDE_MODEL_SELECTION,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const threadId = materialized.projectionThreadIds[0];
  assert.isDefined(threadId);
  // The harness builds its services inside this wrapper's context, and both read one database.
  const wrapper = DisplayModeWrap.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(
      Layer.merge(
        ServerSettings.layerTest({
          threadDisplayModes:
            input.displayMode === undefined ? {} : { [threadId]: input.displayMode },
        }),
        layerNoProviders,
      ),
    ),
  );
  const result = yield* SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      runOrchestratorV2ProviderReplayScenario(
        {
          name: `${input.scenario}/claudeAgent:display-mode`,
          transcript,
          commands: materialized.commands,
          steps: materialized.steps,
          projectionThreadIds: materialized.projectionThreadIds,
          runtimePolicyOverride: { cwd: workspace },
        },
        ClaudeOrchestratorReplayHarness,
        { databaseLayer: Layer.succeed(SqlClient.SqlClient, sql) },
      ),
    ),
    Effect.provide(wrapper),
    provideDeterministicTestRuntime,
  );
  return projectionFor(result, input.scenario);
});

const userTexts = (projection: ReturnType<typeof projectionFor>) =>
  projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : []));

describe("display mode wrapper at turn start", () => {
  it.effect("wraps a message that follows the agent's tool work and stores the user's text", () =>
    Effect.gen(function* () {
      const projection = yield* runTwoPrompts({
        scenario: "turn_interrupt_restart",
        fixtureInput: turnInterruptRestartInput(),
        displayMode: "messages-only",
        prompts: {
          "prompt.offer:1": told(TURN_INTERRUPT_MID_TOOL_PROMPT),
          "prompt.offer:2": wrappedPrompt(
            TURN_INTERRUPT_MID_TOOL_PROMPT,
            TURN_INTERRUPT_RECOVERY_PROMPT,
          ),
        },
      });
      assert.deepEqual(userTexts(projection), [
        TURN_INTERRUPT_MID_TOOL_PROMPT,
        TURN_INTERRUPT_RECOVERY_PROMPT,
      ]);
    }),
  );

  it.effect("wraps a message when the agent only wrote plain text since the last one", () =>
    Effect.gen(function* () {
      const projection = yield* runTwoPrompts({
        scenario: "multi_turn",
        fixtureInput: multiTurnInput(),
        displayMode: "messages-only",
        prompts: {
          "prompt.offer:1": told(MULTI_TURN_FIRST_PROMPT),
          "prompt.offer:2": wrappedPrompt(MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT),
        },
      });
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "completed"],
      );
      assert.deepEqual(userTexts(projection), [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT]);
    }),
  );

  it.effect("sends the text unchanged in a Normal thread", () =>
    Effect.gen(function* () {
      const projection = yield* runTwoPrompts({
        scenario: "turn_interrupt_restart",
        fixtureInput: turnInterruptRestartInput(),
        displayMode: undefined,
        prompts: {},
      });
      assert.deepEqual(userTexts(projection), [
        TURN_INTERRUPT_MID_TOOL_PROMPT,
        TURN_INTERRUPT_RECOVERY_PROMPT,
      ]);
    }),
  );
});
