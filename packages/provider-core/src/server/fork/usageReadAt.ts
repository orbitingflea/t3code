import type { ProviderUsageLimitsUpdate, ServerProviderUsageLimits } from "@t3tools/contracts";

/**
 * Wraps the merge of a runtime update so that every window the update reports loses its reading time,
 * including windows the update reports unchanged; windows it leaves out keep theirs.
 */
export function withRuntimeUpdateReadAt<
  I extends {
    readonly previous: ServerProviderUsageLimits | undefined;
    readonly update: ProviderUsageLimitsUpdate;
  },
>(merge: (input: I) => ServerProviderUsageLimits | undefined) {
  return (input: I): ServerProviderUsageLimits | undefined => {
    const next = merge(input);
    const reported = new Set(input.update.windows.map((window) => window.id));
    if (!next?.windows.some((window) => window.readAt !== undefined && reported.has(window.id))) {
      return next;
    }
    return {
      ...next,
      windows: next.windows.map(({ readAt, ...window }) =>
        reported.has(window.id) || readAt === undefined ? window : { ...window, readAt },
      ),
    };
  };
}
