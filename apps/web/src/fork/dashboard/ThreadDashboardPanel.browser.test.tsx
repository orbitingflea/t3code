import {
  DASHBOARD_SLOT_IDS,
  type DashboardSlotId,
  EnvironmentId,
  ThreadId,
  type ThreadDashboard,
  type ThreadDashboardSlot,
} from "@t3tools/contracts";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { observeAssistantCitationCommentSource } from "../../components/chat/AssistantCitationSource";
import { render } from "../../../test/render";
import { DashboardCards } from "./ThreadDashboardPanel";

type SlotFields = Partial<Omit<ThreadDashboardSlot, "slot">>;

const dashboard = (slots: Partial<Record<DashboardSlotId, SlotFields>> = {}): ThreadDashboard => ({
  threadId: ThreadId.make("dashboard-thread"),
  slots: DASHBOARD_SLOT_IDS.map((slot) => ({
    slot,
    text: "",
    updatedAt: null,
    seenText: null,
    ...slots[slot],
  })),
});

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("dashboard-thread"),
};

function Cards(
  props: Partial<ComponentProps<typeof DashboardCards>> & { readonly dashboard: ThreadDashboard },
) {
  return (
    <DashboardCards threadRef={threadRef} onCite={() => true} onMarkSeen={() => {}} {...props} />
  );
}

const highlighted = () =>
  [...(CSS.highlights.get("t3-dashboard-change")?.keys() ?? [])].map((range) => range.toString());

const card = (container: HTMLElement, slot: DashboardSlotId) =>
  container.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;

const slotText = (container: HTMLElement, slot: DashboardSlotId) =>
  card(container, slot).querySelector(".chat-markdown p")!.firstChild as Text;

function select(from: Text, start: number, to: Text, end: number) {
  const range = document.createRange();
  range.setStart(from, start);
  range.setEnd(to, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

const citeButton = () => page.getByRole("button", { name: "Cite selection in composer" });

describe("DashboardCards", () => {
  it("shows the six slots in page order and marks empty ones", async () => {
    await using screen = await render(
      <Cards
        dashboard={dashboard({ merged: { text: "PR 12", seenText: "PR 12", updatedAt: null } })}
        onMarkSeen={() => {}}
      />,
    );
    const titles = [...screen.container.querySelectorAll("h3")].map((title) => title.textContent);
    expect(titles).toEqual([
      "Needs your decision",
      "Waiting",
      "Working",
      "Auto review",
      "Human review",
      "Recently merged",
    ]);
    expect(screen.container.querySelectorAll("[data-slot] .chat-markdown")[0]!.textContent).toBe(
      "(empty)",
    );
    expect(screen.container.querySelector("[data-unread]")).toBeNull();
  });

  it("strikes only double-tilde text", async () => {
    await using screen = await render(
      <Cards
        dashboard={dashboard({ working: { text: "1~2 and 3~4, ~~gone~~", updatedAt: null } })}
      />,
    );
    const body = card(screen.container, "working").querySelector(".chat-markdown")!;
    expect(body.textContent).toBe("1~2 and 3~4, gone");
    expect([...body.querySelectorAll("del")].map((node) => node.textContent)).toEqual(["gone"]);
  });

  it("highlights only what the user has not read, and all of a slot they never read", async () => {
    await using screen = await render(
      <Cards
        dashboard={dashboard({
          decide: { text: "Pick A or B", updatedAt: "2026-11-07T00:00:00.000Z" },
          working: {
            text: "- Waiting on the CI run for PR 123\n- Docs",
            seenText: "- Waiting on the CI run for PR 12\n- Docs",
            updatedAt: "2026-11-07T00:00:00.000Z",
          },
        })}
        onMarkSeen={() => {}}
      />,
    );
    await vi.waitFor(() => expect(highlighted().sort()).toEqual(["3", "Pick A or B"]));
    const unread = [...screen.container.querySelectorAll<HTMLElement>("[data-unread]")];
    expect(unread.map((element) => element.dataset.slot)).toEqual(["decide", "working"]);

    await screen.unmount();
    expect(highlighted()).toEqual([]);
  });

  it("marks a changed slot read on a click or Enter, but not on a link", async () => {
    const onMarkSeen = vi.fn();
    const text = "See [the docs](https://example.com/docs) first";
    await using screen = await render(
      <Cards
        dashboard={dashboard({ waiting: { text, updatedAt: "2026-11-07T00:00:00.000Z" } })}
        onMarkSeen={onMarkSeen}
      />,
    );
    screen.container.addEventListener("click", (event) => event.preventDefault(), {
      capture: true,
    });

    await userEvent.click(screen.container.querySelector("a")!);
    expect(onMarkSeen).not.toHaveBeenCalled();

    await userEvent.click(card(screen.container, "waiting"), { position: { x: 4, y: 4 } });
    expect(onMarkSeen).toHaveBeenCalledWith("waiting", text);

    card(screen.container, "waiting").focus();
    await userEvent.keyboard("{Enter}");
    expect(onMarkSeen).toHaveBeenCalledTimes(2);
    await userEvent.keyboard(" ");
    expect(onMarkSeen).toHaveBeenCalledTimes(3);

    await userEvent.click(card(screen.container, "decide"), { position: { x: 4, y: 4 } });
    expect(onMarkSeen).toHaveBeenCalledTimes(3);
  });

  it.each([
    { slot: "decide", state: "read" },
    { slot: "waiting", state: "unread" },
  ] as const)("cites selected text of a $state slot without marking it read", async ({ slot }) => {
    const onCite = vi.fn(() => true);
    const onMarkSeen = vi.fn();
    await using screen = await render(
      <Cards
        dashboard={dashboard({
          decide: { text: "Pick A or B", seenText: "Pick A or B" },
          waiting: { text: "CI for PR 12", updatedAt: "2026-11-07T00:00:00.000Z" },
        })}
        onCite={onCite}
        onMarkSeen={onMarkSeen}
      />,
    );
    const text = slotText(screen.container, slot);
    select(text, 0, text, 6);

    await userEvent.click(citeButton());

    expect(onCite).toHaveBeenCalledWith(
      expect.objectContaining({
        ...threadRef,
        messageId: `dashboard-slot-${slot}`,
        text: text.data.slice(0, 6),
      }),
      expect.anything(),
    );
    expect(onMarkSeen).not.toHaveBeenCalled();
  });

  it("offers no Cite for a selection across two slots", async () => {
    await using screen = await render(
      <Cards dashboard={dashboard({ decide: { text: "Pick A" }, waiting: { text: "CI run" } })} />,
    );
    const decide = slotText(screen.container, "decide");
    select(decide, 0, decide, 4);
    await expect.element(citeButton()).toBeVisible();

    select(decide, 0, slotText(screen.container, "waiting"), 2);
    await expect.element(citeButton()).not.toBeInTheDocument();
  });

  it("tells an open comment on a slot quote that its source is gone when the Dashboard closes", async () => {
    const onCite = vi.fn<ComponentProps<typeof DashboardCards>["onCite"]>(() => true);
    await using screen = await render(
      <Cards dashboard={dashboard({ decide: { text: "Pick A" } })} onCite={onCite} />,
    );
    const text = slotText(screen.container, "decide");
    select(text, 0, text, 4);
    await userEvent.click(citeButton());
    const [citation, anchor] = onCite.mock.calls[0]!;
    const onUnavailable = vi.fn();
    using _observer = {
      [Symbol.dispose]: observeAssistantCitationCommentSource({ anchor, citation, onUnavailable }),
    };

    await screen.unmount();
    await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledOnce());
  });
});
