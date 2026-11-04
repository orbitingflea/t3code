import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ProviderReplayTranscript } from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";

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

const WRAPPED_RECOVERY_PROMPT = [
  "<t3-messages-mode>",
  "This message is from the user. Other things happened in this thread since your last message to them, or since the thread began if you sent none. The user's screen showed:",
  `[user] ${TURN_INTERRUPT_MID_TOOL_PROMPT}`,
  "</t3-messages-mode>",
  TURN_INTERRUPT_RECOVERY_PROMPT,
].join("\n");

// The replay fails unless each prompt the adapter sends matches the transcript exactly.
const expectSecondPrompt = (
  transcript: ProviderReplayTranscript,
  text: string,
): ProviderReplayTranscript => ({
  ...transcript,
  entries: transcript.entries.map((entry) =>
    entry.type === "expect_outbound" && entry.label === "prompt.offer:2"
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
      : entry,
  ),
});

const runTwoPrompts = Effect.fn("runTwoPrompts")(function* (input: {
  readonly scenario: string;
  readonly fixtureInput: OrchestratorFixtureInput;
  readonly displayMode: string | undefined;
  readonly secondPrompt: string;
}) {
  const recorded = yield* readProviderReplayTranscript(
    new URL(
      `../../orchestration-v2/testkit/fixtures/${input.scenario}/claude_transcript.ndjson`,
      import.meta.url,
    ),
  ).pipe(Effect.provide(NodeServices.layer));
  const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
    materializeReplayTranscriptRuntimeInstructions(
      expectSecondPrompt(recorded, input.secondPrompt),
      { driver: ProviderDriverKind.make("claudeAgent"), model: CLAUDE_MODEL_SELECTION.model },
    ),
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
  const result = yield* runOrchestratorV2ProviderReplayScenario(
    {
      name: `${input.scenario}/claudeAgent:display-mode`,
      transcript,
      commands: materialized.commands,
      steps: materialized.steps,
      projectionThreadIds: materialized.projectionThreadIds,
      runtimePolicyOverride: { cwd: workspace },
    },
    ClaudeOrchestratorReplayHarness,
    input.displayMode === undefined
      ? {}
      : { serverSettings: { threadDisplayModes: { [threadId]: input.displayMode } } },
  ).pipe(provideDeterministicTestRuntime);
  return projectionFor(result, input.scenario);
});

const userTexts = (projection: ReturnType<typeof projectionFor>) =>
  projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : []));

describe("display mode wrapper at turn start", () => {
  it.effect("wraps a message that follows the agent's tool work and stores the person's text", () =>
    Effect.gen(function* () {
      const projection = yield* runTwoPrompts({
        scenario: "turn_interrupt_restart",
        fixtureInput: turnInterruptRestartInput(),
        displayMode: "messages-only",
        secondPrompt: WRAPPED_RECOVERY_PROMPT,
      });
      assert.deepEqual(userTexts(projection), [
        TURN_INTERRUPT_MID_TOOL_PROMPT,
        TURN_INTERRUPT_RECOVERY_PROMPT,
      ]);
    }),
  );

  it.effect("sends a message unchanged when the agent only wrote text since the last one", () =>
    Effect.gen(function* () {
      const projection = yield* runTwoPrompts({
        scenario: "multi_turn",
        fixtureInput: multiTurnInput(),
        displayMode: "messages-only",
        secondPrompt: MULTI_TURN_SECOND_PROMPT,
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
        secondPrompt: TURN_INTERRUPT_RECOVERY_PROMPT,
      });
      assert.deepEqual(userTexts(projection), [
        TURN_INTERRUPT_MID_TOOL_PROMPT,
        TURN_INTERRUPT_RECOVERY_PROMPT,
      ]);
    }),
  );
});
