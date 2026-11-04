import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";

/**
 * Gives the wrapper an empty provider list, so the wrapper knows no slash commands.
 * Tests that build the runtime layer use this layer.
 */
export const layerNoProviders = Layer.mock(ProviderRegistry.ProviderRegistry)({
  getProviders: Effect.succeed([]),
});
