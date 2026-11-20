import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { chatFileTarget } from "../workArea/chatFileOpener";
import { PRIMARY_CHAT } from "../workArea/workArea.logic";
import {
  change,
  focusedIndex,
  fromChat,
  paneAt,
  ref,
  resetWorkAreaStore,
  shape,
  store,
  tab,
  WIDE,
} from "../workArea/workAreaTestKit";
import { publishWorkAreaView } from "../workArea/workAreaView";
import { openThreadDashboard } from "./dashboardLink";

vi.mock("./dashboardSurface", () => ({
  FORK_SURFACES: { dashboard: { icon: () => null } },
  threadHasModeSurface: () => true,
}));

const fromPrimaryChat = () => chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, ref);

beforeEach(resetWorkAreaStore);

describe("a Dashboard link in a chat", () => {
  it("opens the Dashboard beside the Chat it sits in, not in the focused pane", () => {
    publishWorkAreaView(WIDE);
    fromChat(() => store().open(ref, "diff"));
    store().open(ref, "files");
    change({
      type: "place",
      source: { tabs: [tab("files")] },
      at: { kind: "edge", pane: paneAt(0).id, edge: "left" },
    });
    change({ type: "focus", pane: paneAt(0).id });
    openThreadDashboard(ref, fromPrimaryChat);
    expect(shape()).toEqual({
      axis: "row",
      first: { axis: "row", first: ["files"], second: ["chat"] },
      second: ["diff", "dashboard"],
    });
  });

  it("focuses the pane that already shows the Dashboard", () => {
    publishWorkAreaView(WIDE);
    fromChat(() => store().open(ref, "dashboard"));
    change({ type: "focus", pane: paneAt(0).id });
    openThreadDashboard(ref, fromPrimaryChat);
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["dashboard"] });
    expect(focusedIndex()).toBe(1);
  });
});
