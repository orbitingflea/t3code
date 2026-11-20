import * as Schema from "effect/Schema";

import { ForwardCompatibleOptional, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ProviderInstanceId } from "../providerInstance.ts";

/**
 * A pool id travels where an instance id does (a model selection's `instanceId`), so it keeps the
 * instance id rules. The server swaps it for one member before anything is persisted.
 */
export const ProviderPoolId = ProviderInstanceId.pipe(Schema.brand("ProviderPoolId"));
export type ProviderPoolId = typeof ProviderPoolId.Type;

export const ProviderPoolConfig = Schema.Struct({
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  members: Schema.Array(ProviderInstanceId),
});
export type ProviderPoolConfig = typeof ProviderPoolConfig.Type;

/**
 * Entries stay unparsed so one bad pool never fails the whole settings file. The server parses and
 * checks each entry, and drops the ones that fail.
 */
export const ProviderPools = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderPools = typeof ProviderPools.Type;

export const ProviderPoolsSetting = ForwardCompatibleOptional(ProviderPools);
