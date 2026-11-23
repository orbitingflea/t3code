let opening: string | null = null;

/** Runs a Find request that also opens `threadKey`'s own page, such as a search result's. */
export function openingThreadPage(threadKey: string, open: () => void): void {
  const outer = opening;
  opening = threadKey;
  try {
    open();
  } finally {
    opening = outer;
  }
}

export const findOpensThreadPage = (threadKey: string): boolean => opening === threadKey;
