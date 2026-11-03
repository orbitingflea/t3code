import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const FetchedAt = Schema.Struct({ fetched_at: Schema.optional(Schema.String) });
const decodeFetchedAt = Schema.decodeUnknownOption(Schema.fromJsonString(FetchedAt));

/**
 * The `fetched_at` of a usage source's usage answer: t3switch serves an account's last good
 * reading, up to hours old, while the provider refuses reads.
 */
export function usageReadAt(body: string): string | undefined {
  return decodeFetchedAt(body).pipe(
    Option.flatMap(({ fetched_at }) => Option.fromNullishOr(fetched_at)),
    Option.flatMap(DateTime.make),
    Option.map(DateTime.formatIso),
    Option.getOrUndefined,
  );
}

/** Adds the reading's time to limits read from a usage source; unavailable limits have none. */
export function withUsageReadAt<A extends ServerProviderUsageLimits>(
  limits: A,
  readAt: string | undefined,
): A {
  return readAt === undefined || limits.unavailable ? limits : { ...limits, readAt };
}

/** Adds the reading's time from a usage source's usage answer to an account read from it. */
export function withAccountReadAt<A extends { readonly usageLimits: ServerProviderUsageLimits }>(
  body: string,
  account: A,
): A {
  return { ...account, usageLimits: withUsageReadAt(account.usageLimits, usageReadAt(body)) };
}
