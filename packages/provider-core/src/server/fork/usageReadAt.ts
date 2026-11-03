import type { ProviderUsageLimitsUpdate, ServerProviderUsageLimits } from "@t3tools/contracts";

/**
 * Returns the probed limits with the runtime update's newer check time and windows.
 * The result keeps the published reading time, because the published windows that no runtime update replaced came from that reading.
 */
export function withRuntimeWindows(
  probed: ServerProviderUsageLimits,
  published: ServerProviderUsageLimits,
): ServerProviderUsageLimits {
  const { readAt: _readAt, ...fresh } = probed;
  return {
    ...fresh,
    ...(published.readAt !== undefined ? { readAt: published.readAt } : {}),
    checkedAt: published.checkedAt,
    windows: published.windows,
  };
}

/**
 * Wraps the merge of a runtime update so that the result keeps the previous reading time
 * while some previous window is missing from the update, and drops it once the update reports every previous window.
 */
export function withRuntimeUpdateReadAt<
  I extends {
    readonly previous: ServerProviderUsageLimits | undefined;
    readonly update: ProviderUsageLimitsUpdate;
  },
>(merge: (input: I) => ServerProviderUsageLimits | undefined) {
  return (input: I): ServerProviderUsageLimits | undefined => {
    const next = merge(input);
    const readAt = input.previous?.readAt;
    if (next === undefined || next.unavailable || readAt === undefined) {
      return next;
    }
    const reported = new Set(input.update.windows.map((window) => window.id));
    if (input.previous?.windows.some((window) => !reported.has(window.id))) {
      return next.readAt === readAt ? next : { ...next, readAt };
    }
    const { readAt: _readAt, ...fresh } = next;
    return next.readAt === undefined ? next : fresh;
  };
}
