import type { ServerProviderUsageLimits } from "@t3tools/contracts";

/** Takes a runtime update's newer windows, which outdate a usage source's reading time. */
export function withRuntimeWindows(
  probed: ServerProviderUsageLimits,
  published: ServerProviderUsageLimits,
): ServerProviderUsageLimits {
  const { readAt: _readAt, ...fresh } = probed;
  return { ...fresh, checkedAt: published.checkedAt, windows: published.windows };
}
