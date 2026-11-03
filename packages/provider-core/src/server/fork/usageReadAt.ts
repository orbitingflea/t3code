import type { ServerProviderUsageLimits } from "@t3tools/contracts";

/** Returns the probed limits with the runtime update's newer check time and windows, and without the usage source's reading time. */
export function withRuntimeWindows(
  probed: ServerProviderUsageLimits,
  published: ServerProviderUsageLimits,
): ServerProviderUsageLimits {
  const { readAt: _readAt, ...fresh } = probed;
  return { ...fresh, checkedAt: published.checkedAt, windows: published.windows };
}
