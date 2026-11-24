import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { addBrowserSurface } from "~/components/preview/addBrowserSurface";
import { useComposerDraftStore } from "~/composerDraftStore";
import { subThreadDraftId } from "~/fork/subThreads/subThreadReply";

import { chatFileTarget } from "./chatFileOpener";
import {
  type ArmKind,
  focusedTab,
  LAUNCHER,
  paneHolding,
  PRIMARY_CHAT,
  replyTabId,
  secondaryChatTabId,
} from "./workArea.logic";
import { drawWorkArea, isStripView } from "./workAreaGeometry.logic";
import { armFocusedPane, openFromPaneMenu } from "./workAreaCommands";
import {
  actives,
  change,
  env,
  focusedIndex,
  fromChat,
  layout,
  other,
  paneAt,
  panes,
  ref,
  resetWorkAreaStore,
  type Shape,
  shape,
  store,
  tab,
  WIDE,
  wide,
} from "./workAreaTestKit";
import {
  captureOpenOrigin,
  currentWorkAreaView,
  publishWorkAreaView,
  runWithOpenOrigin,
} from "./workAreaView";

const session = vi.hoisted(() => ({ open: (_tabId: string) => {} }));
vi.mock("~/components/preview/openPreviewSession", () => ({
  openPreviewSession: () =>
    new Promise((resolve) => {
      session.open = (tabId) => resolve({ _tag: "Success", value: { tabId } });
    }),
}));

beforeEach(resetWorkAreaStore);

describe("the launcher tab", () => {
  const splitLauncher = () => change({ type: "split-launcher", pane: paneAt(0).id });

  it("splits a lone pane right with a focused launcher, and only a lone pane", () => {
    publishWorkAreaView(WIDE);
    splitLauncher();
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["launcher"] });
    expect(focusedIndex()).toBe(1);
    const once = layout();
    splitLauncher();
    expect(layout()).toBe(once);
  });

  it("refuses to split a lone pane where the halves do not fit", () => {
    publishWorkAreaView(wide(570));
    splitLauncher();
    expect(shape()).toEqual(["chat"]);
  });

  /** New tab's browser pick: the browser exists only after an await, while another pane takes focus. */
  const pickBrowser = async (meanwhile: () => void) => {
    change({ type: "arm", armed: { pane: paneAt(1).id, kind: "preview" } });
    const created = runWithOpenOrigin({ record: ref, tab: LAUNCHER, adjacent: true }, () =>
      addBrowserSurface({ threadRef: ref, openPreview: vi.fn() }),
    );
    change({ type: "focus", pane: paneAt(0).id });
    meanwhile();
    session.open("t1");
    await created;
  };

  it.each<[string, () => unknown, Shape, readonly string[]]>([
    [
      "keeps the launcher when a file opened from the Chat lands beside it",
      () => fromChat(() => store().openFile(ref, "a.ts")),
      { axis: "row", first: ["chat"], second: ["launcher", "file:a.ts"] },
      ["chat", "file:a.ts"],
    ],
    [
      "replaces the launcher with a surface opened from it",
      () => {
        armFocusedPane(ref, "diff");
        store().open(ref, "diff");
      },
      { axis: "row", first: ["chat"], second: ["diff"] },
      ["chat", "diff"],
    ],
    [
      "closes the launcher's pane with the launcher",
      () => change({ type: "close", tab: LAUNCHER }),
      ["chat"],
      ["chat"],
    ],
    [
      "keeps the launcher when a dropped thread joins its pane",
      () =>
        change({
          type: "place",
          source: { threads: [other] },
          at: { kind: "join", pane: paneAt(1).id },
        }),
      { axis: "row", first: ["chat"], second: ["launcher", secondaryChatTabId(other)] },
      ["chat", secondaryChatTabId(other)],
    ],
    [
      "replaces the launcher with a browser picked in it, after another pane took the focus",
      () => pickBrowser(() => {}),
      { axis: "row", first: ["chat"], second: ["browser:t1"] },
      ["chat", "browser:t1"],
    ],
    [
      "replaces the launcher with a browser picked in it whose session was listed first",
      () => pickBrowser(() => store().reconcileBrowserSurfaces(ref, ["t1"])),
      { axis: "row", first: ["chat"], second: ["browser:t1"] },
      ["chat", "browser:t1"],
    ],
  ])("%s", async (_name, act, expectedShape, expectedActives) => {
    publishWorkAreaView(WIDE);
    splitLauncher();
    await act();
    expect(shape()).toEqual(expectedShape);
    expect(actives()).toEqual(expectedActives);
  });

  it("moves a surface already open in another pane into the launcher's pane, which it replaces", () => {
    const narrow = publishWorkAreaView({ narrow: true, size: null });
    store().open(ref, "diff");
    narrow();
    change({ type: "activate", tab: PRIMARY_CHAT });
    publishWorkAreaView(WIDE);
    splitLauncher();
    armFocusedPane(ref, "diff");
    store().open(ref, "diff");
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["diff"] });
    expect(focusedIndex()).toBe(1);
  });

  it("keeps a side chat picked in the launcher of a 700 px area out of the strip view", () => {
    publishWorkAreaView(wide(700));
    splitLauncher();
    change({ type: "arm", armed: { pane: paneAt(1).id, kind: "thread" } });
    runWithOpenOrigin({ record: ref, tab: LAUNCHER, adjacent: true }, () =>
      store().openThread(ref, ThreadId.make("side")),
    );
    expect(shape()).toEqual(["chat", "thread:side"]);
    expect(isStripView(layout(), currentWorkAreaView())).toBe(false);
  });

  it("keeps a side chat chosen in a 340 px pane's add menu out of the strip view", () => {
    publishWorkAreaView(wide(700));
    fromChat(() => store().openFile(ref, "a.ts"));
    change({ type: "arm", armed: { pane: paneAt(1).id, kind: "thread" } });
    store().openThread(ref, ThreadId.make("side"));
    expect(shape()).toEqual({ axis: "row", first: ["chat", "thread:side"], second: ["file:a.ts"] });
    expect(actives()).toEqual(["thread:side", "file:a.ts"]);
    expect(isStripView(layout(), currentWorkAreaView())).toBe(false);
  });

  it.each<[string, ArmKind, () => () => unknown, string]>([
    [
      "a browser",
      "preview",
      () => {
        const created = addBrowserSurface({ threadRef: ref, openPreview: vi.fn() });
        return () => {
          session.open("t1");
          return created;
        };
      },
      "browser:t1",
    ],
    [
      "a side chat",
      "thread",
      () => {
        const later = captureOpenOrigin();
        return () => later(() => store().openThread(ref, ThreadId.make("side")));
      },
      "thread:side",
    ],
  ])(
    "opens %s chosen in an ordinary pane's add menu in that pane, after another pane took the focus",
    async (_name, kind, start, opened) => {
      publishWorkAreaView(WIDE);
      fromChat(() => store().openFile(ref, "a.ts"));
      store().openFile(ref, "b.ts");
      change({
        type: "place",
        source: { tabs: [tab("file:b.ts")] },
        at: { kind: "edge", pane: paneAt(1).id, edge: "right" },
      });
      const menuPane = paneAt(2).id;
      let finish: () => unknown = () => {};
      openFromPaneMenu(ref, menuPane, kind, () => {
        finish = start();
      });
      change({ type: "focus", pane: paneAt(1).id });
      await finish();
      expect(paneHolding(layout().root, tab(opened))?.id).toBe(menuPane);
    },
  );

  it("ends an add-menu pick whose async open settles with no tab, but not a newer pick of its pane and kind", async () => {
    publishWorkAreaView(WIDE);
    fromChat(() => store().openFile(ref, "a.ts"));
    const menuPane = paneAt(1).id;
    let fail = (_: Error) => {};
    const first = openFromPaneMenu(
      ref,
      menuPane,
      "thread",
      () =>
        new Promise<never>((_, reject) => {
          fail = reject;
        }),
    );
    let settle = (_: boolean) => {};
    const second = openFromPaneMenu(
      ref,
      menuPane,
      "thread",
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );

    fail(new Error("rejected"));
    await expect(first).rejects.toThrow("rejected");
    expect(layout().armed).toEqual({ pane: menuPane, kind: "thread" });
    settle(false);
    await second;
    expect(layout().armed).toBeUndefined();
  });

  it("puts the Chat picked in the launcher in the launcher's place", () => {
    publishWorkAreaView(WIDE);
    change({
      type: "place",
      source: { threads: [other] },
      at: { kind: "edge", pane: paneAt(0).id, edge: "right" },
    });
    change({ type: "close", tab: PRIMARY_CHAT });
    splitLauncher();
    change({ type: "arm", armed: { pane: paneAt(1).id, kind: "chat" } });
    change({ type: "place", source: { threads: [ref] }, at: { kind: "join", pane: paneAt(1).id } });
    expect(shape()).toEqual({ axis: "row", first: [secondaryChatTabId(other)], second: ["chat"] });
    expect(focusedIndex()).toBe(1);
  });
});

describe("reply tabs", () => {
  const fromPrimary = () => chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, ref);
  const fromList = () => chatFileTarget({ kind: "own", tab: tab("replies"), adjacent: true }, ref);
  const reveal = (first: string) => fromPrimary().openSubThread(first, { reveal: "find" });
  const quote = (first: string) => fromPrimary().openSubThread(first, { reveal: "quote" });

  it.each<[string, () => void, () => void, Shape, readonly string[]]>([
    [
      "a Reply from the Chat beside a 339 px Replies pane joins the Chat's pane",
      () => {
        publishWorkAreaView(wide(700));
        fromChat(() => store().open(ref, "replies"));
      },
      () => fromPrimary().openSubThread("m-1"),
      { axis: "row", first: ["chat", replyTabId(ref, "m-1")], second: ["replies"] },
      [replyTabId(ref, "m-1"), "replies"],
    ],
    [
      "a thread link from the Chat beside a 339 px Replies pane joins the Chat's pane",
      () => {
        publishWorkAreaView(wide(700));
        fromChat(() => store().open(ref, "replies"));
      },
      () => fromPrimary().openThread(other),
      { axis: "row", first: ["chat", secondaryChatTabId(other)], second: ["replies"] },
      [secondaryChatTabId(other), "replies"],
    ],
    [
      "a Reply from the Chat beside a 239 px Files pane widens that pane to 360 px",
      () => {
        publishWorkAreaView(wide(800));
        fromChat(() => store().openFile(ref, "a.ts"));
        const root = layout().root;
        if (root.kind === "split") change({ type: "ratio", split: root.id, ratio: 0.7 });
      },
      () => fromPrimary().openSubThread("m-1"),
      { axis: "row", first: ["chat"], second: ["file:a.ts", replyTabId(ref, "m-1")] },
      ["chat", replyTabId(ref, "m-1")],
    ],
    [
      "a Reply from the Replies list in [Chat | Replies] lands right after the list",
      () => {
        publishWorkAreaView(WIDE);
        fromChat(() => store().open(ref, "replies"));
      },
      () => fromList().openSubThread("m-1"),
      { axis: "row", first: ["chat"], second: ["replies", replyTabId(ref, "m-1")] },
      ["chat", replyTabId(ref, "m-1")],
    ],
    [
      "a Reply from a 299 px Replies list widens the list's pane to 360 px",
      () => {
        publishWorkAreaView(WIDE);
        fromChat(() => store().open(ref, "replies"));
        const root = layout().root;
        if (root.kind === "split") change({ type: "ratio", split: root.id, ratio: 0.75 });
      },
      () => fromList().openSubThread("m-1"),
      { axis: "row", first: ["chat"], second: ["replies", replyTabId(ref, "m-1")] },
      ["chat", replyTabId(ref, "m-1")],
    ],
    [
      "a Reply from a 339 px Replies list joins the Chat's pane",
      () => {
        publishWorkAreaView(wide(700));
        fromChat(() => store().open(ref, "replies"));
      },
      () => fromList().openSubThread("m-1"),
      { axis: "row", first: ["chat", replyTabId(ref, "m-1")], second: ["replies"] },
      [replyTabId(ref, "m-1"), "replies"],
    ],
  ])("at its size, %s and the layout stays panes", (_name, arrange, act, expected, active) => {
    arrange();
    act();
    expect(shape()).toEqual(expected);
    expect(actives()).toEqual(active);
    expect(isStripView(layout(), currentWorkAreaView())).toBe(false);
  });

  it.each<[string, () => void, () => void, Shape, readonly string[]]>([
    [
      "shows a reply's open tab again, adding none",
      () => {
        chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, ref).openSubThread("m-1");
        fromChat(() => store().openFile(ref, "a.ts"));
      },
      () => chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, ref).openSubThread("m-1"),
      { axis: "row", first: ["chat"], second: [replyTabId(ref, "m-1"), "file:a.ts"] },
      ["chat", replyTabId(ref, "m-1")],
    ],
    [
      "opens a reply from the Replies list beside the list, which stays",
      () => store().open(ref, "replies"),
      () => chatFileTarget({ kind: "own", tab: tab("replies") }, ref).openSubThread("m-1"),
      { axis: "row", first: ["chat", replyTabId(ref, "m-1")], second: ["replies"] },
      [replyTabId(ref, "m-1"), "replies"],
    ],
    [
      "opens a secondary Chat's reply in the owner's layout under that thread's id",
      () =>
        change({
          type: "place",
          source: { threads: [other] },
          at: { kind: "edge", pane: paneAt(0).id, edge: "right" },
        }),
      () =>
        chatFileTarget(
          { kind: "shown", owner: ref, tab: secondaryChatTabId(other) },
          other,
        ).openSubThread("m-1"),
      {
        axis: "row",
        first: ["chat", replyTabId(other, "m-1")],
        second: [secondaryChatTabId(other)],
      },
      [replyTabId(other, "m-1"), secondaryChatTabId(other)],
    ],
    [
      "keeps a revealed reply behind the Chat where a split does not fit",
      () => publishWorkAreaView(wide(570)),
      () => reveal("m-1"),
      ["chat", replyTabId(ref, "m-1")],
      ["chat"],
    ],
    [
      "shows a revealed reply in the one strip of a narrow window, right after the Chat",
      () => {
        fromChat(() => store().openFile(ref, "a.ts"));
        change({ type: "focus", pane: paneAt(0).id });
        publishWorkAreaView({ narrow: true, size: { width: 400, height: 800 } });
      },
      () => reveal("m-1"),
      { axis: "row", first: ["chat", replyTabId(ref, "m-1")], second: ["file:a.ts"] },
      [replyTabId(ref, "m-1"), "file:a.ts"],
    ],
  ])("%s", (_name, arrange, act, expectedShape, expectedActives) => {
    arrange();
    act();
    expect(shape()).toEqual(expectedShape);
    expect(actives()).toEqual(expectedActives);
  });

  it("shows a revealed reply that shares the Chat's pane in another pane with room, keeping the focus", () => {
    publishWorkAreaView(WIDE);
    fromChat(() => store().openFile(ref, "a.ts"));
    reveal("m-1");
    const reply = replyTabId(ref, "m-1");
    change({ type: "place", source: { tabs: [reply] }, at: { kind: "join", pane: paneAt(0).id } });
    change({ type: "activate", tab: PRIMARY_CHAT });
    expect(shape()).toEqual({ axis: "row", first: ["chat", reply], second: ["file:a.ts"] });
    reveal("m-1");
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: ["file:a.ts", reply] });
    expect(actives()).toEqual(["chat", reply]);
    expect(focusedIndex()).toBe(0);
  });

  it("draws the next revealed reply, open in another pane, in the one strip that drew the last", () => {
    const first = replyTabId(ref, "m-1");
    const next = replyTabId(ref, "m-2");
    publishWorkAreaView(WIDE);
    fromPrimary().openSubThread("m-1");
    fromPrimary().openSubThread("m-2");
    change({ type: "place", source: { tabs: [first] }, at: { kind: "join", pane: paneAt(0).id } });
    change({ type: "activate", tab: PRIMARY_CHAT });
    expect(shape()).toEqual({ axis: "row", first: ["chat", first], second: [next] });
    const strip = { narrow: true, size: { width: 400, height: 800 } };
    publishWorkAreaView(strip);
    const drawn = () => drawWorkArea(layout(), strip).panes.map((pane) => pane.active);
    reveal("m-1");
    expect(drawn()).toEqual([first]);
    reveal("m-2");
    expect(drawn()).toEqual([next]);
  });

  it.each<[string, () => void, Shape, readonly string[]]>([
    [
      "beside the Chat in panes",
      () => publishWorkAreaView(WIDE),
      { axis: "row", first: ["chat"], second: [replyTabId(ref, "m-2")] },
      ["chat", replyTabId(ref, "m-2")],
    ],
    [
      "over the Chat where a split does not fit",
      () => publishWorkAreaView(wide(570)),
      ["chat", replyTabId(ref, "m-2")],
      [replyTabId(ref, "m-2")],
    ],
    [
      "in the one strip of a narrow window",
      () => {
        fromChat(() => store().openFile(ref, "a.ts"));
        change({ type: "focus", pane: paneAt(0).id });
        publishWorkAreaView({ narrow: true, size: { width: 400, height: 800 } });
      },
      { axis: "row", first: ["chat", replyTabId(ref, "m-2")], second: ["file:a.ts"] },
      [replyTabId(ref, "m-2"), "file:a.ts"],
    ],
  ])(
    "shows a quoted reply %s, and the next quote replaces its tab",
    (_name, arrange, expectedShape, expectedActives) => {
      arrange();
      quote("m-1");
      expect(focusedTab(layout())).toBe(replyTabId(ref, "m-1"));
      quote("m-2");
      expect(shape()).toEqual(expectedShape);
      expect(actives()).toEqual(expectedActives);
      expect(focusedTab(layout())).toBe(replyTabId(ref, "m-2"));
    },
  );

  it("replaces the reply tab the last reveal opened with the next reveal's, keeping the focus", () => {
    publishWorkAreaView(WIDE);
    reveal("m-1");
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: [replyTabId(ref, "m-1")] });
    reveal("m-2");
    reveal("m-3");
    expect(shape()).toEqual({ axis: "row", first: ["chat"], second: [replyTabId(ref, "m-3")] });
    expect(actives()).toEqual(["chat", replyTabId(ref, "m-3")]);
    expect(focusedIndex()).toBe(0);
  });

  it.each<[string, () => void]>([
    ["activated", () => change({ type: "activate", tab: replyTabId(ref, "m-1") })],
    ["focused", () => change({ type: "focus", pane: paneAt(1).id })],
    ["opened", () => fromPrimary().openSubThread("m-1")],
    [
      "drafted in",
      () =>
        useComposerDraftStore
          .getState()
          .setPrompt(subThreadDraftId(scopedThreadKey(ref), "m-1")!, "a note"),
    ],
  ])("keeps a revealed reply tab the user %s when the next reveal opens", (_name, takeOver) => {
    publishWorkAreaView(WIDE);
    reveal("m-1");
    change({ type: "focus", pane: paneAt(0).id });
    takeOver();
    change({ type: "focus", pane: paneAt(0).id });
    reveal("m-2");
    expect(panes().flatMap((pane) => pane.tabs)).toEqual([
      "chat",
      replyTabId(ref, "m-1"),
      replyTabId(ref, "m-2"),
    ]);
  });

  it("keeps reply tab ids apart for any thread and message ids", () => {
    const colon = scopeThreadRef(env, ThreadId.make("a:b"));
    const plain = scopeThreadRef(env, ThreadId.make("a"));
    expect(replyTabId(colon, "c")).not.toBe(replyTabId(plain, "b:c"));
    expect(replyTabId(colon, "c").startsWith("reply:")).toBe(true);
  });
});
