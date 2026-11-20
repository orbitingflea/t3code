import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useThreadFindHighlights } from "../../components/chat/threadFindHighlights";
import { SubThreadViewContext } from "./subThreadsState";

function ReplyView(props: {
  readonly first: string;
  readonly container: HTMLElement;
  readonly query: string;
}) {
  return (
    <SubThreadViewContext value={props.first}>
      <Highlights container={props.container} query={props.query} />
    </SubThreadViewContext>
  );
}

function Highlights(props: { readonly container: HTMLElement; readonly query: string }) {
  useThreadFindHighlights({
    container: props.container,
    query: props.query,
    activeRowId: null,
    activeOccurrence: 0,
    onActiveRange: () => {},
  });
  return null;
}

function timeline(text: string) {
  const container = document.createElement("div");
  container.style.cssText = "height: 200px; width: 300px; overflow: auto";
  container.innerHTML = `<div data-timeline-row-id="row"><div data-thread-find-text>${text}</div></div>`;
  document.body.append(container);
  return { container, [Symbol.dispose]: () => container.remove() };
}

const paintedIn = (element: Element) =>
  [...(CSS.highlights.get("t3-sub-thread-find") ?? [])].filter((range) =>
    element.contains(range.startContainer),
  ).length;

it("keeps each reply view's Find highlights while another view repaints or goes", async () => {
  using left = timeline("deploy then deploy");
  using right = timeline("one deploy");
  const views = (rightQuery: string, showRight: boolean) => (
    <>
      <ReplyView first="m-1" container={left.container} query="deploy" />
      {showRight ? <ReplyView first="m-1" container={right.container} query={rightQuery} /> : null}
    </>
  );
  await using screen = await render(views("deploy", true));
  await vi.waitFor(() =>
    expect([paintedIn(left.container), paintedIn(right.container)]).toEqual([2, 1]),
  );

  await screen.rerender(views("", true));
  await vi.waitFor(() =>
    expect([paintedIn(left.container), paintedIn(right.container)]).toEqual([2, 0]),
  );

  await screen.rerender(views("deploy", true));
  await vi.waitFor(() => expect(paintedIn(right.container)).toBe(1));
  await screen.rerender(views("deploy", false));
  await vi.waitFor(() =>
    expect([paintedIn(left.container), paintedIn(right.container)]).toEqual([2, 0]),
  );
});
