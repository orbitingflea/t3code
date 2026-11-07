import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { createRef, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

interface Row {
  readonly id: string;
  readonly height: number;
}

const tallRows: Row[] = Array.from({ length: 30 }, (_, index) => ({
  id: `row-${index}`,
  height: 200,
}));

function List({ listRef, rows }: { listRef: RefObject<LegendListRef | null>; rows: Row[] }) {
  return (
    <div style={{ height: 400 }}>
      <LegendList<Row>
        ref={listRef}
        data={rows}
        keyExtractor={(row) => row.id}
        estimatedItemSize={200}
        maintainVisibleContentPosition={{ data: true, size: true }}
        renderItem={({ item }) => <div style={{ height: item.height }}>{item.id}</div>}
        style={{ height: "100%" }}
      />
    </div>
  );
}

describe("LegendList scrollToEnd", () => {
  it("does not jump to the top when the last row goes away during the scroll", async () => {
    const listRef = createRef<LegendListRef>();
    await using screen = await render(
      <List listRef={listRef} rows={[...tallRows, { id: "working", height: 40 }]} />,
      { router: false },
    );
    await vi.waitFor(() => expect(listRef.current).not.toBeNull());
    const node = listRef.current!.getScrollableNode() as HTMLElement;
    await act(() => listRef.current!.scrollToOffset({ offset: 2000, animated: false }));
    await vi.waitFor(() => expect(node.scrollTop).toBe(2000));

    void listRef.current!.scrollToEnd({ animated: true });
    await vi.waitFor(() => expect(node.scrollTop).toBeGreaterThan(2000), { interval: 5 });
    await screen.rerender(<List listRef={listRef} rows={tallRows} />);

    await vi.waitFor(() =>
      expect(node.scrollTop).toBeGreaterThanOrEqual(node.scrollHeight - node.clientHeight - 1),
    );
  });
});
