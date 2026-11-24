import { describe, expect, it } from "vite-plus/test";

import {
  arrangeSurfaceActions,
  parseMenuLayer,
  type RightPanelMenuItemId,
  setMenuChoice,
} from "./menu.logic";

// Today's menu: the upstream items' own letters, then the fork's Replies, Dashboard and Whiteboard.
const TODAY: ReadonlyArray<readonly [RightPanelMenuItemId, string]> = [
  ["browser", "B"],
  ["terminal", "T"],
  ["files", "F"],
  ["diff", "D"],
  ["pull-request", "P"],
  ["pull-requests", "L"],
  ["device", "M"],
  ["side-chat", "S"],
  ["replies", ""],
  ["dashboard", ""],
  ["whiteboard", "W"],
];

// A board host hides these until a layer shows them.
const DEVELOPER_ITEMS: ReadonlyArray<RightPanelMenuItemId> = [
  "diff",
  "pull-request",
  "pull-requests",
  "device",
];
const SHOW_DEVELOPER_ITEMS = Object.fromEntries(
  DEVELOPER_ITEMS.map((id) => [id, { hidden: false }]),
);

const actions = (disabled: ReadonlyArray<RightPanelMenuItemId>) =>
  TODAY.map(([id, shortcut]) => ({
    id,
    shortcut,
    available: !disabled.includes(id),
    label: `${id} label`,
  }));

describe("arrangeSurfaceActions", () => {
  it.each<{
    name: string;
    machine?: Record<string, unknown>;
    browser?: Record<string, unknown>;
    disabled?: ReadonlyArray<RightPanelMenuItemId>;
    letters?: Partial<Record<RightPanelMenuItemId, string>>;
    hidden?: ReadonlyArray<RightPanelMenuItemId>;
    // The menu also offers the Chat action, as it does while the primary Chat is closed.
    chat?: boolean;
  }>([
    {
      name: "empty layers hide Diff, Pull request, Linked items and Device",
      hidden: DEVELOPER_ITEMS,
    },
    {
      name: "a browser that shows them keeps today's letters",
      browser: SHOW_DEVELOPER_ITEMS,
    },
    {
      name: "a browser that shows Diff gets it back with its letter",
      browser: { diff: { hidden: false } },
      hidden: ["pull-request", "pull-requests", "device"],
    },
    {
      name: "the machine shows Device for a browser with no choice",
      machine: { device: { hidden: false } },
      hidden: ["diff", "pull-request", "pull-requests"],
    },
    {
      name: "a browser that hides Device beats the machine that shows it",
      machine: { device: { hidden: false } },
      browser: { device: { hidden: true } },
      hidden: DEVELOPER_ITEMS,
    },
    {
      name: "a browser letter alone leaves Diff hidden and its letter free",
      browser: { diff: { key: "D" }, dashboard: { key: "D" } },
      hidden: DEVELOPER_ITEMS,
      letters: { dashboard: "D" },
    },
    {
      name: "shown items keep today's letters on disabled items",
      browser: SHOW_DEVELOPER_ITEMS,
      disabled: ["browser", "diff", "side-chat", "whiteboard"],
    },
    {
      name: "unknown ids and fields that do not parse change nothing",
      machine: { future: { hidden: true, key: "B" }, files: "hidden", diff: [] },
      browser: {
        ...SHOW_DEVELOPER_ITEMS,
        browser: { hidden: "yes", key: "BB" },
        terminal: { key: "é" },
      },
    },
    {
      name: "the machine hides items and the browser shows one again",
      machine: { files: { hidden: true }, diff: { hidden: true } },
      browser: SHOW_DEVELOPER_ITEMS,
      hidden: ["files"],
    },
    {
      name: "no letter is a choice, not inheritance",
      machine: { terminal: { key: "X" } },
      browser: { ...SHOW_DEVELOPER_ITEMS, terminal: { key: "" } },
      letters: { terminal: "" },
    },
    {
      name: "a browser letter, upper-cased, beats a built-in one",
      browser: { ...SHOW_DEVELOPER_ITEMS, whiteboard: { key: "f" } },
      letters: { whiteboard: "F", files: "" },
    },
    {
      name: "a machine letter beats a built-in one",
      machine: { dashboard: { key: "B" } },
      browser: SHOW_DEVELOPER_ITEMS,
      letters: { dashboard: "B", browser: "" },
    },
    {
      name: "a browser letter beats a machine one",
      machine: { dashboard: { key: "Q" } },
      browser: { ...SHOW_DEVELOPER_ITEMS, replies: { key: "Q" } },
      letters: { replies: "Q" },
    },
    {
      name: "the earlier item wins a tie within a layer",
      browser: { ...SHOW_DEVELOPER_ITEMS, dashboard: { key: "Q" }, replies: { key: "Q" } },
      letters: { replies: "Q" },
    },
    {
      name: "an available item keeps its letter over a disabled item's browser choice",
      browser: { ...SHOW_DEVELOPER_ITEMS, whiteboard: { key: "B" } },
      disabled: ["whiteboard"],
      letters: { whiteboard: "" },
    },
    {
      name: "among disabled items the layer that set the letter wins",
      machine: { device: { key: "D" } },
      browser: SHOW_DEVELOPER_ITEMS,
      disabled: ["diff", "device"],
      letters: { device: "D", diff: "" },
    },
    {
      name: "an item gets its letter back where the winner is hidden",
      browser: { ...SHOW_DEVELOPER_ITEMS, whiteboard: { key: "F", hidden: true } },
      hidden: ["whiteboard"],
    },
    {
      name: "the Chat action, which restores the primary Chat, ignores a choice to hide it",
      chat: true,
      machine: { chat: { hidden: true } },
      browser: { ...SHOW_DEVELOPER_ITEMS, chat: { hidden: true } },
    },
    {
      name: "every item can be hidden",
      machine: Object.fromEntries(TODAY.map(([id]) => [id, { hidden: true }])),
      hidden: TODAY.map(([id]) => id),
    },
  ])("$name", ({ machine = {}, browser = {}, disabled = [], letters = {}, hidden = [], chat }) => {
    const input = [
      ...actions(disabled),
      ...(chat
        ? [{ id: "chat" as const, shortcut: "", available: true, label: "chat label" }]
        : []),
    ];
    const expected = input
      .filter((action) => !hidden.includes(action.id))
      .map((action) => ({ ...action, shortcut: letters[action.id] ?? action.shortcut }));

    expect(arrangeSurfaceActions(input, parseMenuLayer(machine), parseMenuLayer(browser))).toEqual(
      expected,
    );
  });
});

describe("setMenuChoice", () => {
  it("replaces one item's choice, removes an empty one and keeps unknown ids", () => {
    const layer = { files: { hidden: true, key: "Q" }, future: { key: "Z" } };
    expect(setMenuChoice(layer, "files", { key: "Q" })).toEqual({
      files: { key: "Q" },
      future: { key: "Z" },
    });
    expect(setMenuChoice(layer, "files", {})).toEqual({ future: { key: "Z" } });
  });

  it("starts a new layer when the stored one is malformed", () => {
    expect(setMenuChoice(null, "files", { hidden: true })).toEqual({ files: { hidden: true } });
  });
});

describe("parseMenuLayer", () => {
  it.each([null, "files", 3, ["files"]])("reads a malformed stored layer %j as empty", (raw) => {
    expect(parseMenuLayer(raw)).toEqual({});
  });
});
