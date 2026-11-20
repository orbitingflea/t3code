import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { startPanelLinkDrag } from "./panelLinkDrag";
import { useLinkDrops } from "./useLinkDrops";
import { asPaneId } from "./workArea.logic";

const env = EnvironmentId.make("env-1");
const first = scopeThreadRef(env, ThreadId.make("thread-first"));
const second = scopeThreadRef(env, ThreadId.make("thread-second"));

type Open = Parameters<typeof useLinkDrops>[0]["open"];

function Drops(props: { readonly owner: ScopedThreadRef; readonly open: Open }) {
  useLinkDrops({
    owner: props.owner,
    planAt: () => ({
      at: { kind: "join", pane: asPaneId("p0") },
      ghost: { kind: "box", left: 0, top: 0, width: 10, height: 10 },
    }),
    show: () => {},
    open: props.open,
  });
  return (
    <>
      <a
        href="https://example.com/e"
        onDragStart={(event) =>
          startPanelLinkDrag(event, { panelRef: first, open: () => new Promise(() => {}) })
        }
      >
        Link e
      </a>
      <div style={{ width: 200, height: 200 }}>Drop here</div>
    </>
  );
}

describe("useLinkDrops", () => {
  it.each([
    ["keeps", "stays", first, true],
    ["cancels", "becomes another thread", second, false],
  ] as const)(
    "%s a drop still opening when the work area's owner %s",
    async (_, _owner, next, live) => {
      let dropLive: (() => boolean) | null = null;
      const open = vi.fn<Open>((link, _at, isLive) => {
        dropLive = isLive;
        return link.open();
      });
      await using screen = await render(<Drops owner={first} open={open} />);

      await userEvent.dragAndDrop(
        page.getByRole("link", { name: "Link e" }),
        page.getByText("Drop here"),
      );
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      expect(dropLive!()).toBe(true);

      await screen.rerender(<Drops owner={next} open={open} />);
      expect(dropLive!()).toBe(live);
    },
  );
});
