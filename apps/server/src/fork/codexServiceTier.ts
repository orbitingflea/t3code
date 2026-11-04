import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";

import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";

/**
 * The tier for a Codex `turn/start`. Codex keeps the thread's last tier when the field is
 * omitted, so a turn without a pick sends the tier the picker shows: Codex's configured tier,
 * else the catalog default, else "default". A turn with neither a pick nor a tier picker omits
 * the tier.
 */
export function resolveCodexTurnServiceTier(
  modelSelection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel>,
): string | undefined {
  const shown = models
    .find((model) => model.slug === modelSelection.model)
    ?.capabilities?.optionDescriptors?.find((descriptor) => descriptor.id === "serviceTier");
  return (
    getCodexServiceTierOptionValue(modelSelection) ??
    (shown?.type === "select" ? shown.currentValue : undefined)
  );
}
