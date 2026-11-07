import {
  DASHBOARD_SLOT_IDS,
  type DashboardSlotId,
  ThreadId,
  type ThreadDashboard,
  type ThreadDashboardSlot,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

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

const highlighted = () =>
  [...(CSS.highlights.get("t3-dashboard-change")?.keys() ?? [])].map((range) => range.toString());

const card = (container: HTMLElement, slot: DashboardSlotId) =>
  container.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;

describe("DashboardCards", () => {
  it("shows the six slots in page order and marks empty ones", async () => {
    await using screen = await render(
      <DashboardCards
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

  it("highlights only what the user has not read, and all of a slot they never read", async () => {
    await using screen = await render(
      <DashboardCards
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
      <DashboardCards
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

    await userEvent.click(card(screen.container, "decide"), { position: { x: 4, y: 4 } });
    expect(onMarkSeen).toHaveBeenCalledTimes(2);
  });
});
