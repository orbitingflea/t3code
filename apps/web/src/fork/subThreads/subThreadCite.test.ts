import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type AssistantCitation, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../../components/ui/toast";
import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { chatFileTarget } from "../workArea/chatFileOpener";
import {
  asPaneId,
  holders,
  isReplyEntry,
  PRIMARY_CHAT,
  type ReplyEntry,
  replyTabId,
  resolveLayout,
  stripEntries,
  type TabId,
} from "../workArea/workArea.logic";
import { drawWorkArea, NO_VIEW } from "../workArea/workAreaGeometry.logic";
import { citeInThread, citeOpensReplies, registerReplyBox } from "./subThreadCite";

const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
const threadKey = scopedThreadKey(threadRef);
const citation: AssistantCitation = {
  version: 1,
  ...threadRef,
  messageId: MessageId.make("first-b"),
  text: "Pick A",
  start: 0,
  end: 6,
  prefix: "",
  suffix: " or B",
};
const opaqueSourceAnchor = {} as AssistantCitationSourceAnchor;

function fakeBox(text: string, answer = true) {
  const cite = vi.fn(() => answer);
  const ref = {
    current: {
      readSnapshot: () => ({ value: text, cursor: 0, expandedCursor: 0, contextIds: [] }),
      citeAssistantText: cite,
    },
  };
  return { ref, cite };
}
type FakeBox = ReturnType<typeof fakeBox>;

function mainView(ownText = "") {
  useRightPanelStore.setState(useRightPanelStore.getInitialState());
  const toast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
  const own = fakeBox(ownText);
  return {
    toast,
    ownCite: own.cite,
    cite: () => citeInThread(threadRef, "first-b", own.ref, citation, opaqueSourceAnchor),
    [Symbol.dispose]: () => toast.mockRestore(),
  };
}

const replyTab = (first: string) => replyTabId(threadRef, first);
const record = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
const layout = () => resolveLayout(record());
const shownTabs = () => drawWorkArea(layout(), NO_VIEW).panes.map((pane) => pane.active);
const firstView = (tab: TabId) => ({ pane: holders(layout().root, tab)[0]!.id, tab });

/** Opens `first`'s reply tab beside the primary Chat, as a Reply in the main list does. */
const openReply = (first: string, options?: { readonly reveal?: "find" | "quote" }) =>
  chatFileTarget({ kind: "own", tab: PRIMARY_CHAT }, threadRef).openSubThread(first, options);

/** The reply tab's strip entry, which a tab's body is keyed by from its open until its close. */
function entryOf(first: string): ReplyEntry {
  const [entry] = stripEntries(layout(), record(), [replyTab(first)], threadRef, "Chat");
  if (entry === undefined || !isReplyEntry(entry)) throw new Error(`no reply tab for ${first}`);
  return entry;
}

/** A reply box that mounts once its tab is in the layout; `unmount` stands for a hidden tab. */
function replyBox(first: string, box: FakeBox) {
  let mounted: ReturnType<typeof registerReplyBox> | null = null;
  const mount = () => {
    if (mounted === null && layout().tabs[replyTab(first)] !== undefined)
      mounted = registerReplyBox(entryOf(first), threadKey, first, box.ref);
  };
  const unmount = () => {
    mounted?.[Symbol.dispose]();
    mounted = null;
  };
  mount();
  const stop = useRightPanelStore.subscribe(mount);
  return {
    focus: () => mounted?.focused(),
    unmount,
    remount: () => {
      unmount();
      mount();
    },
    [Symbol.dispose]: () => {
      stop();
      unmount();
    },
  };
}

/** Covers a reply tab with a file in its own pane. */
function coverReply(first: string) {
  useRightPanelStore.getState().openFile(threadRef, "a.ts");
  expect(shownTabs()).not.toContain(replyTab(first));
}

describe("a Cite in the main list of a Chat mode thread", () => {
  it.each([
    { replies: undefined, opens: false },
    { replies: 0, opens: false },
    { replies: 1, opens: true },
  ])("opens the message's Replies only when it has some: $replies", ({ replies, opens }) => {
    const summary =
      replies === undefined
        ? undefined
        : {
            first: "first-b",
            firstFrom: "agent" as const,
            firstText: "Pick A or B",
            replies,
            lastAt: "2026-11-16T00:00:00.000Z",
            lastFrom: "agent" as const,
            lastText: "Pick A or B",
            agentReplyTimes: [],
          };
    expect(citeOpensReplies(summary)).toBe(opens);
  });

  it("goes into the main box when it has text", () => {
    using view = mainView(" my note ");
    const reply = fakeBox("a reply draft");
    using _reply = replyBox("first-a", reply);
    openReply("first-a");

    expect(view.cite()).toBe(true);
    expect(view.ownCite).toHaveBeenCalledExactlyOnceWith(citation, opaqueSourceAnchor);
    expect(reply.cite).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "goes into a shown reply box with text, and returns its answer %s",
    (answer) => {
      using view = mainView();
      const reply = fakeBox("a reply draft", answer);
      using _reply = replyBox("first-a", reply);
      openReply("first-a");

      expect(view.cite()).toBe(answer);
      expect(reply.cite).toHaveBeenCalledExactlyOnceWith(citation, opaqueSourceAnchor);
      expect(view.ownCite).not.toHaveBeenCalled();
      expect(view.toast).toHaveBeenCalledTimes(answer ? 0 : 1);
    },
  );

  it.each([
    ["the one focused last", ["first-a", "first-c"], "first-c"],
    ["the one focused last, not the one registered last", ["first-c", "first-a"], "first-a"],
  ])("goes, of two shown boxes with drafts, into %s", (_name, focusOrder, expected) => {
    using view = mainView();
    const boxes = { "first-a": fakeBox("draft a"), "first-c": fakeBox("draft c") };
    openReply("first-a");
    openReply("first-c");
    useRightPanelStore.getState().updateWorkArea(threadRef, {
      type: "place",
      source: { view: firstView(replyTab("first-c")) },
      at: { kind: "edge", pane: drawWorkArea(layout(), NO_VIEW).panes[1]!.id, edge: "bottom" },
    });
    using a = replyBox("first-a", boxes["first-a"]);
    using c = replyBox("first-c", boxes["first-c"]);
    const handles = { "first-a": a, "first-c": c };
    for (const first of focusOrder) handles[first as keyof typeof handles].focus();

    expect(view.cite()).toBe(true);
    expect(boxes[expected as keyof typeof boxes].cite).toHaveBeenCalledOnce();
    for (const [first, box] of Object.entries(boxes)) {
      if (first !== expected) expect(box.cite).not.toHaveBeenCalled();
    }
  });

  it("keeps the focus order of a box whose tab was hidden and shown again", () => {
    using view = mainView();
    const boxA = fakeBox("draft a");
    const boxC = fakeBox("draft c");
    openReply("first-a");
    openReply("first-c");
    useRightPanelStore.getState().updateWorkArea(threadRef, {
      type: "place",
      source: { view: firstView(replyTab("first-c")) },
      at: { kind: "edge", pane: drawWorkArea(layout(), NO_VIEW).panes[1]!.id, edge: "bottom" },
    });
    using a = replyBox("first-a", boxA);
    using c = replyBox("first-c", boxC);
    a.focus();
    c.focus();
    c.remount();
    a.remount();

    expect(view.cite()).toBe(true);
    expect(boxC.cite).toHaveBeenCalledOnce();
    expect(boxA.cite).not.toHaveBeenCalled();
  });

  it("goes into the view of a reply open in two panes whose box was focused last", () => {
    using view = mainView();
    openReply("first-a");
    const left = fakeBox("draft a");
    const right = fakeBox("draft a");
    const entry = entryOf("first-a");
    const inLeft = registerReplyBox(entry, threadKey, "first-a", left.ref, asPaneId("p1"));
    const inRight = registerReplyBox(entry, threadKey, "first-a", right.ref, asPaneId("p2"));
    try {
      inRight.focused();
      inLeft.focused();

      expect(view.cite()).toBe(true);
      expect(left.cite).toHaveBeenCalledOnce();
      expect(right.cite).not.toHaveBeenCalled();
    } finally {
      inLeft[Symbol.dispose]();
      inRight[Symbol.dispose]();
    }
  });

  it("forgets the focus of a reply tab that was closed and opened again", () => {
    using view = mainView();
    const boxA = fakeBox("draft a");
    const boxC = fakeBox("draft c");
    openReply("first-a");
    openReply("first-c");
    using a = replyBox("first-a", boxA);
    using c = replyBox("first-c", boxC);
    c.focus();
    a.focus();
    useRightPanelStore
      .getState()
      .updateWorkArea(threadRef, { type: "close", tab: replyTab("first-a") });
    a.unmount();
    openReply("first-a", { reveal: "find" });

    expect(view.cite()).toBe(true);
    expect(boxC.cite).toHaveBeenCalledOnce();
    expect(boxA.cite).not.toHaveBeenCalled();
  });

  it("goes into a shown box with a draft rather than an empty one focused later", () => {
    using view = mainView();
    const draft = fakeBox("draft a");
    const empty = fakeBox("");
    openReply("first-a");
    openReply("first-c");
    useRightPanelStore.getState().updateWorkArea(threadRef, {
      type: "place",
      source: { view: firstView(replyTab("first-c")) },
      at: { kind: "edge", pane: drawWorkArea(layout(), NO_VIEW).panes[1]!.id, edge: "bottom" },
    });
    using a = replyBox("first-a", draft);
    using c = replyBox("first-c", empty);
    a.focus();
    c.focus();

    expect(view.cite()).toBe(true);
    expect(draft.cite).toHaveBeenCalledOnce();
    expect(empty.cite).not.toHaveBeenCalled();
  });

  it.each([
    { start: "no reply tab is open", open: null, cover: false },
    { start: "another sub-thread's tab is shown with an empty box", open: "first-a", cover: false },
    { start: "the cited tab is open under another tab", open: "first-b", cover: true },
  ])("opens or shows the cited tab and goes into its box when $start", ({ open, cover }) => {
    using view = mainView();
    const store = useRightPanelStore.getState();
    const other = fakeBox("");
    const cited = fakeBox("");
    if (open !== null) openReply(open);
    if (cover && open !== null) coverReply(open);
    using _other = replyBox("first-a", other);
    using _cited = replyBox("first-b", cited);
    const revision = store.getUserActionRevision(threadRef);

    expect(view.cite()).toBe(true);
    expect(cited.cite).toHaveBeenCalledExactlyOnceWith(citation, opaqueSourceAnchor);
    expect(other.cite).not.toHaveBeenCalled();
    expect(view.ownCite).not.toHaveBeenCalled();
    expect(shownTabs()).toContain(replyTab("first-b"));
    expect(store.getUserActionRevision(threadRef)).toBe(revision + 1);
  });

  it("returns the cited box's refusal after opening it", () => {
    using view = mainView();
    const cited = fakeBox("", false);
    using _cited = replyBox("first-b", cited);

    expect(view.cite()).toBe(false);
    expect(cited.cite).toHaveBeenCalledOnce();
    expect(view.toast).toHaveBeenCalledOnce();
  });

  it("keeps the selection when no reply box mounts after the open", () => {
    using view = mainView();

    expect(view.cite()).toBe(false);
    expect(view.toast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Could not open the reply box" }),
    );
    expect(view.ownCite).not.toHaveBeenCalled();
  });

  it("treats a box that shows only whitespace as empty", () => {
    using view = mainView(" \n\t");
    const blank = fakeBox(" \n");
    openReply("first-a");
    using _blank = replyBox("first-a", blank);
    const cited = fakeBox("");
    using _cited = replyBox("first-b", cited);

    expect(view.cite()).toBe(true);
    expect(view.ownCite).not.toHaveBeenCalled();
    expect(blank.cite).not.toHaveBeenCalled();
    expect(cited.cite).toHaveBeenCalledOnce();
  });
});
