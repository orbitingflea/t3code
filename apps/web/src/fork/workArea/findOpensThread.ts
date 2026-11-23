let opening = false;

/** Runs a Find request that also opens the thread's own page, such as a search result's. */
export function openingThreadPage(open: () => void): void {
  opening = true;
  try {
    open();
  } finally {
    opening = false;
  }
}

export const findOpensThreadPage = (): boolean => opening;
