import { describe, expect, it } from "vite-plus/test";

import { citedThreadSnapshot, loadCitedHistory } from "../../components/chat/citationProcedure";

type SnapshotInput = Parameters<typeof citedThreadSnapshot>[0];

const send = {
  type: "dynamic_tool",
  id: "turn-item:send",
  status: "completed",
  toolName: "mcp__t3-code__send_to_user",
  input: { text: "Done" },
};

describe("a quote of a send_to_user reply", () => {
  it("finds a loaded reply without paging older history", async () => {
    let pages = 0;
    const outcome = await loadCitedHistory({
      signal: new AbortController().signal,
      readThread: async () =>
        citedThreadSnapshot({
          thread: {
            projection: { visibleTurnItems: [{ item: send }] },
          } as unknown as SnapshotInput["thread"],
          history: {
            historyCursor: "older",
            hasMoreHistory: true,
            loading: false,
            error: null,
            expanded: false,
            latestLocalTurnOrdinal: null,
          },
          status: "live",
          error: null,
          messageId: send.id,
        }),
      loadThrough: async () => {
        pages += 1;
        return { _tag: "loaded" };
      },
    });
    expect({ outcome, pages }).toEqual({ outcome: { _tag: "found" }, pages: 0 });
  });
});
