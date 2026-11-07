import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
} from "../../components/threadActionMenu.logic";
import { displayModeMenuItems, displayModePatch } from "./useThreadDisplayMode";

const threadRef = {
  environmentId: EnvironmentId.make("environment-without-config"),
  threadId: ThreadId.make("thread-a"),
};

const menuState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [],
  displayModeItems: [
    {
      id: "display-mode",
      label: "Display mode",
      icon: "message-square",
      children: [
        { id: "display-mode:normal", label: "Normal", checked: false },
        { id: "display-mode:messages-only", label: "Messages only", checked: true },
      ],
    },
  ],
};

describe("Display mode menu", () => {
  it("is hidden when the server has not said it can store a mode", () => {
    expect(displayModeMenuItems(threadRef)).toEqual([]);
  });

  it("stores Messages only and clears the key for Normal", () => {
    expect(displayModePatch(threadRef, "display-mode:messages-only")).toEqual({
      threadDisplayModes: { "thread-a": "messages-only" },
    });
    expect(displayModePatch(threadRef, "display-mode:normal")).toEqual({
      threadDisplayModes: { "thread-a": null },
    });
  });

  it("sits after Auto-settle behavior and is disabled with the others without permission", () => {
    const ids = buildThreadActionMenuItems(menuState).map((item) => item.id);
    expect(ids.slice(ids.indexOf("auto-settle"), ids.indexOf("auto-settle") + 2)).toEqual([
      "auto-settle",
      "display-mode",
    ]);
    const readOnly = buildThreadActionMenuItems({ ...menuState, canOperate: false });
    expect(readOnly.find((item) => item.id === "display-mode")?.children).toMatchObject([
      { disabled: true },
      { disabled: true },
    ]);
  });
});
