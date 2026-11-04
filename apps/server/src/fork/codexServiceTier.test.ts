import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { buildCodexTurnStartParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  applyConfiguredCodexServiceTier,
  mapCodexModelCapabilities,
} from "../provider/CodexProvider.ts";

const catalogModel = (defaultServiceTier: string | null): ServerProviderModel => ({
  slug: "gpt-5.4",
  name: "GPT-5.4",
  isCustom: false,
  capabilities: mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "medium",
    description: "",
    displayName: "gpt-5.4",
    hidden: false,
    id: "gpt-5.4",
    isDefault: true,
    model: "gpt-5.4",
    defaultServiceTier,
    serviceTiers: [{ id: "fast", name: "Fast", description: "" }],
    supportedReasoningEfforts: [{ description: "", reasoningEffort: "medium" }],
  }),
});

const serviceTier = (
  options: ReadonlyArray<ProviderOptionSelection>,
  models: ReadonlyArray<ServerProviderModel>,
) =>
  buildCodexTurnStartParams({
    nativeThreadId: "native-service-tier",
    codexInput: [{ type: "text", text: "test" }],
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4", options },
    models,
  }).pipe(Effect.map((params) => params.serviceTier));

it.effect("Codex turns send the tier the picker shows", () =>
  Effect.gen(function* () {
    const configuredFast = applyConfiguredCodexServiceTier([catalogModel(null)], "fast");
    assert.equal(yield* serviceTier([{ id: "serviceTier", value: "fast" }], []), "fast");
    assert.equal(
      yield* serviceTier([{ id: "serviceTier", value: "default" }], configuredFast),
      "default",
    );
    assert.equal(yield* serviceTier([], configuredFast), "fast");
    assert.equal(yield* serviceTier([], [catalogModel("fast")]), "fast");
    assert.equal(yield* serviceTier([], [catalogModel(null)]), "default");
    assert.equal(yield* serviceTier([], []), undefined);
  }),
);
