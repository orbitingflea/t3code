import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { MessageId, ThreadId } from "@t3tools/contracts";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { assistantCitationRoute } from "~/lib/assistantCitationNavigation";

import {
  decideHistoryMove,
  decideMove,
  type HistoryMove,
  isTabStep,
  type Move,
  planPush,
  readTabEntry,
  type Shown,
  type TabEntry,
  userShownTabChange,
} from "./tabHistory.logic";
import {
  isWorkAreaTabStep,
  markTabHistoryThreadDeleted,
  noteAppModalClose,
  onlyOwnTabPushesSince,
  watchTabHistory,
} from "./tabHistory";
import { createTabTags, tabHistoryTags, type TabTags } from "./tabHistoryTags";
import { asTabId, DEFAULT_LAYOUT, focusedTab, PRIMARY_CHAT, replyTabId } from "./workArea.logic";
import {
  change,
  layout,
  onePane,
  other,
  ref,
  resetWorkAreaStore,
  store,
  third,
} from "./workAreaTestKit";
import { publishWorkAreaView } from "./workAreaView";

const KEY = scopedThreadKey(ref);
const THREAD = `/${ref.environmentId}/${ref.threadId}`;
const OTHER = `/${other.environmentId}/${other.threadId}`;
const A = asTabId("file:a.ts");
const B = asTabId("file:b.ts");
const C = asTabId("file:c.ts");
const entry = (tab: string, thread = KEY): TabEntry => ({ thread, tab: asTabId(tab) });
const pushed = (tab: string, thread = KEY): TabEntry => ({ ...entry(tab, thread), pushed: true });
const entryState = (key: string) => ({ __TSR_index: 0, key, __TSR_key: key });
const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

beforeEach(resetWorkAreaStore);

describe("readTabEntry", () => {
  it.each([
    { value: { thread: KEY, tab: "chat" }, read: entry("chat") },
    { value: { thread: KEY, tab: "chat", extra: 3 }, read: entry("chat") },
    { value: undefined, read: null },
    { value: null, read: null },
    { value: "chat", read: null },
    { value: [KEY, "chat"], read: null },
    { value: { thread: KEY }, read: null },
    { value: { thread: KEY, tab: 3 }, read: null },
    { value: { thread: null, tab: "chat" }, read: null },
    { value: { thread: KEY, tab: "chat", pushed: true }, read: pushed("chat") },
    { value: { thread: KEY, tab: "chat", dead: true }, read: { ...entry("chat"), dead: true } },
    { value: { thread: KEY, tab: "chat", pushed: false }, read: null },
    { value: { thread: KEY, tab: "chat", dead: "yes" }, read: null },
  ])("reads $value as $read", ({ value, read }) => {
    expect(readTabEntry(value)).toEqual(read);
  });
});

describe("createTabTags", () => {
  it("reads its tags back from storage and keeps the newest 500", () => {
    const storage = memoryStorage();
    const tags = createTabTags(() => storage);
    for (let n = 0; n <= 500; n++) tags.set(entryState(`key-${n}`), entry("chat"));
    tags.set(entryState("key-1"), entry(A));

    const reloaded = createTabTags(() => storage);
    expect(
      ["key-0", "key-1", "key-2", "key-500"].map((key) => reloaded.get(entryState(key))),
    ).toEqual([null, entry(A), entry("chat"), entry("chat")]);
  });

  it("marks every tag of a thread dead and keeps the mark across a reload", () => {
    const storage = memoryStorage();
    const tags = createTabTags(() => storage);
    tags.set(entryState("base"), entry("chat"));
    tags.set(entryState("push"), pushed(A));
    tags.set(entryState("other"), entry("chat", "env-1:thread-other"));
    tags.markDead(KEY);

    const reloaded = createTabTags(() => storage);
    expect(["base", "push", "other"].map((key) => reloaded.get(entryState(key)))).toEqual([
      { ...entry("chat"), dead: true },
      { ...pushed(A), dead: true },
      entry("chat", "env-1:thread-other"),
    ]);
  });

  const blocked = () => {
    throw new Error("blocked");
  };
  it.each([
    { name: "text that is not JSON", storage: { getItem: () => "[", setItem: () => {} } },
    { name: "an object", storage: { getItem: () => "{}", setItem: () => {} } },
    {
      name: "bad rows",
      storage: {
        getItem: () => `[5, ["key"], [7, ${JSON.stringify(entry(B))}], ["key", {"thread": 1}]]`,
        setItem: () => {},
      },
    },
    { name: "blocked storage", storage: { getItem: blocked, setItem: blocked } },
  ])("ignores $name and still records tags", ({ storage }) => {
    const tags = createTabTags(() => storage);
    expect(tags.get(entryState("key"))).toBeNull();
    tags.set(entryState("key"), entry(A));
    expect(tags.get(entryState("key"))).toEqual(entry(A));
  });
});

describe("planPush", () => {
  const plain = (tag: TabEntry | null) => ({ tag, reveal: false });
  it.each([
    {
      name: "retags an untagged entry with the tab left",
      current: plain(null),
      plan: { type: "push", retag: entry("chat"), push: pushed(A) },
    },
    {
      name: "keeps an entry that already names the tab left",
      current: plain(entry("chat")),
      plan: { type: "push", retag: null, push: pushed(A) },
    },
    {
      name: "retags a stale entry",
      current: plain(entry(B)),
      plan: { type: "push", retag: entry("chat"), push: pushed(A) },
    },
    {
      name: "keeps the mark of a stale entry it pushed",
      current: plain(pushed(B)),
      plan: { type: "push", retag: pushed("chat"), push: pushed(A) },
    },
    {
      name: "retags another thread's entry",
      current: plain(pushed("chat", "env-1:thread-other")),
      plan: { type: "push", retag: entry("chat"), push: pushed(A) },
    },
    {
      name: "retags a quote entry for its own reveal",
      current: { tag: entry("chat"), reveal: true },
      plan: { type: "retag", retag: entry(A) },
    },
  ])("$name", ({ current, plan }) => {
    expect(planPush(current, KEY, { from: PRIMARY_CHAT, to: A })).toEqual(plan);
  });

  it("writes nothing when the shown tab came back", () => {
    expect(planPush(plain(null), KEY, { from: A, to: A })).toBeNull();
    expect(planPush({ tag: null, reveal: true }, KEY, { from: A, to: A })).toBeNull();
  });
});

describe("decideMove", () => {
  // [chat, a.ts, b.ts], b.ts shown.
  const threeTabs = () => {
    onePane("a.ts", "b.ts");
    return layout();
  };
  const move = (over: Partial<Move> = {}): Move => ({
    entry: entry(A),
    samePath: true,
    sameHref: true,
    moved: true,
    ...over,
  });
  const deadEntry = move({ entry: { ...entry(A, "env-1:thread-gone"), dead: true } });

  it.each([
    { name: "shows an open tab", move: move(), decision: { type: "show", tab: A } },
    { name: "skips a closed tab", move: move({ entry: entry(C) }), decision: { type: "skip" } },
    {
      name: "skips the tab already shown",
      move: move({ entry: entry(B) }),
      decision: { type: "skip" },
    },
    {
      name: "shows an open tab on an entry with another URL",
      move: move({ sameHref: false }),
      decision: { type: "show", tab: A },
    },
    {
      name: "leaves a closed tab on an entry with another URL to the router",
      move: move({ entry: entry(C), sameHref: false }),
      decision: { type: "none" },
    },
    {
      name: "leaves an entry with another URL and the tab already shown to the router",
      move: move({ entry: entry(B), sameHref: false }),
      decision: { type: "none" },
    },
    {
      name: "ignores a move that stayed",
      move: move({ moved: false }),
      decision: { type: "none" },
    },
    {
      name: "ignores a move to another path",
      move: move({ samePath: false }),
      decision: { type: "none" },
    },
    {
      name: "ignores another thread's entry",
      move: move({ entry: entry(A, "env-1:thread-other") }),
      decision: { type: "none" },
    },
    { name: "ignores an untagged entry", move: move({ entry: null }), decision: { type: "none" } },
    {
      name: "leaves a deleted thread's entry to the history listener",
      move: deadEntry,
      decision: { type: "none" },
    },
  ])("$name", ({ move: theMove, decision }) => {
    const shown: Shown = { thread: KEY, layout: threeTabs() };
    expect(decideMove(theMove, shown)).toEqual(decision);
  });

  it("reads a thread with no record as the default layout", () => {
    const shown: Shown = { thread: KEY, layout: DEFAULT_LAYOUT };
    expect(decideMove(move({ entry: entry("chat") }), shown)).toEqual({ type: "skip" });
  });
});

describe("decideHistoryMove", () => {
  const move = (over: Partial<HistoryMove> = {}): HistoryMove => ({
    entry: entry(A),
    samePath: true,
    moved: true,
    origin: null,
    ...over,
  });
  const dead = { ...pushed(A, "env-1:thread-gone"), dead: true as const };
  const otherThread = "env-1:thread-other";

  it.each([
    { name: "skips a deleted thread's entry", move: move({ entry: dead }), skip: "skip" },
    {
      name: "ignores a deleted thread's entry it did not move to",
      move: move({ entry: dead, moved: false }),
      skip: "none",
    },
    {
      name: "leaves a pushed entry to the thread's view",
      move: move({ entry: pushed(A) }),
      skip: "none",
    },
    {
      name: "leaves a base to the thread's view",
      move: move({ entry: entry("chat"), origin: pushed(B) }),
      skip: "none",
    },
  ])("narrow: $name", ({ move: theMove, skip }) => {
    expect(decideHistoryMove(theMove, false)).toBe(skip);
  });

  it.each([
    { name: "skips a pushed entry", move: move({ entry: pushed(A) }), skip: "skip" },
    {
      name: "skips another thread's pushed entry",
      move: move({ entry: pushed(A, otherThread), samePath: false }),
      skip: "skip",
    },
    { name: "skips a deleted thread's entry", move: move({ entry: dead }), skip: "skip" },
    {
      name: "skips the base of a Back that started on a pushed entry",
      move: move({ entry: entry("chat"), origin: pushed(B) }),
      skip: "skip-base",
    },
    {
      name: "skips an untagged base of a Back that started on a pushed entry",
      move: move({ entry: null, origin: pushed(B) }),
      skip: "skip-base",
    },
    { name: "stops at an entry it did not push", move: move(), skip: "none" },
    {
      name: "stops at a base when the Back started on an entry it did not push",
      move: move({ entry: entry("chat"), origin: entry(B) }),
      skip: "none",
    },
    {
      name: "stops at another path with a base ahead",
      move: move({ entry: null, samePath: false, origin: pushed(B) }),
      skip: "none",
    },
    {
      name: "stops at another thread's entry with a base ahead",
      move: move({ entry: entry("chat", otherThread), origin: pushed(B) }),
      skip: "none",
    },
    {
      name: "ignores a pushed entry it did not move to",
      move: move({ entry: pushed(A), moved: false }),
      skip: "none",
    },
  ])("wide: $name", ({ move: theMove, skip }) => {
    expect(decideHistoryMove(theMove, true)).toBe(skip);
  });
});

describe("isTabStep", () => {
  const move = { entry: entry(A), samePath: true, moved: true };
  it.each([
    { name: "a step between two entries of a thread", move, left: pushed(B), step: true },
    {
      name: "a step to another path",
      move: { ...move, samePath: false },
      left: entry(B),
      step: false,
    },
    {
      name: "a step to an untagged entry",
      move: { ...move, entry: null },
      left: entry(B),
      step: false,
    },
    { name: "a step from an untagged entry", move, left: null, step: false },
    {
      name: "a step from another thread's entry",
      move,
      left: entry(B, "env-1:thread-other"),
      step: false,
    },
    { name: "a step that stayed", move: { ...move, moved: false }, left: entry(B), step: false },
  ])("calls $name a tab step: $step", ({ move: theMove, left, step }) => {
    expect(isTabStep(theMove, left)).toBe(step);
  });
});

describe("userShownTabChange", () => {
  const terminal = () =>
    store().byThreadKey[KEY]!.surfaces.find((surface) => surface.kind === "terminal")!.id;
  const counted = (act: () => void) => {
    onePane("a.ts");
    store().openTerminal(ref, "term-1");
    store().activateSurface(ref, "file:a.ts");
    const prev = store();
    act();
    return userShownTabChange(prev, store(), KEY);
  };

  it.each([
    {
      name: "a press on a display tab",
      act: () => change({ type: "activate", tab: PRIMARY_CHAT }),
    },
    {
      name: "a press on a surface tab",
      act: () => store().activateSurface(ref, terminal()),
    },
    { name: "an open", act: () => store().openFile(ref, "b.ts") },
  ])("counts $name", ({ act }) => {
    publishWorkAreaView({ narrow: true, size: null });
    const shown = counted(act);
    expect(shown).toEqual({ from: A, to: focusedTab(layout()) });
    expect(shown?.to).not.toBe(A);
  });

  it.each([
    { name: "a close", act: () => store().closeSurface(ref, "file:a.ts") },
    { name: "an agent reveal", act: () => store().revealSurface(ref, terminal()) },
    { name: "an automatic open", act: () => store().open(ref, "diff", true) },
    { name: "a user mark alone", act: () => void store().markUserAction(ref) },
    { name: "another thread's open", act: () => store().openFile(other, "b.ts") },
    { name: "removing the deleted thread", act: () => store().removeThread(ref) },
  ])("ignores $name", ({ act }) => {
    publishWorkAreaView({ narrow: true, size: null });
    expect(counted(act)).toBeNull();
  });

  it("counts the first open of a thread with no record", () => {
    const prev = store();
    store().openFile(ref, "a.ts");
    expect(userShownTabChange(prev, store(), KEY)).toEqual({ from: PRIMARY_CHAT, to: A });
  });
});

function threadRouter(entries: readonly string[], basepath?: string) {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const thread = createRoute({ getParentRoute: () => chat, path: "$environmentId/$threadId" });
  const draft = createRoute({ getParentRoute: () => chat, path: "draft/$draftId" });
  const settings = createRoute({ getParentRoute: () => chat, path: "settings" });
  return createRouter({
    routeTree: root.addChildren([chat.addChildren([thread, draft, settings])]),
    history: createMemoryHistory({ initialEntries: [...entries] }),
    ...(basepath === undefined ? {} : { basepath }),
  });
}

const SIDE = ThreadId.make("thread-side");
const SIDE_TAB = asTabId(`thread:${SIDE}`);
const THIRD = `/${third.environmentId}/${third.threadId}`;
const quoteHash = (threadId: ThreadId) =>
  assistantCitationRoute(
    {
      version: 1,
      environmentId: ref.environmentId,
      threadId,
      messageId: MessageId.make("assistant-1"),
      text: "quote",
      start: 0,
      end: 5,
      prefix: "",
      suffix: "",
    },
    null,
  ).hash;

describe("watchTabHistory", () => {
  let tags: TabTags;
  let input: EventTarget;
  // The window's width, which the last watcher started follows, as WorkArea's does.
  let narrowWindow: boolean;
  beforeEach(() => {
    vi.useFakeTimers();
    tags = createTabTags(() => undefined);
    input = new EventTarget();
    narrowWindow = true;
    // [chat, a.ts, b.ts, c.ts], Chat shown.
    onePane("a.ts", "b.ts", "c.ts");
    change({ type: "activate", tab: PRIMARY_CHAT });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const shown = () => focusedTab(layout());
  // Runs the push timers and the skip microtasks.
  const settle = () => vi.runAllTimersAsync();
  // A tab press, with the pointer input that comes before it.
  const press = async (tab: string) => {
    input.dispatchEvent(new Event("pointerdown"));
    store().activateSurface(ref, tab);
    await settle();
  };
  // ChatView's reveal of a side-chat quote on its parent thread.
  const revealSideChat = async () => {
    store().openThread(ref, SIDE);
    await settle();
  };
  const watching = (router: AnyRouter, options: { readonly narrow?: boolean } = {}): Disposable => {
    narrowWindow = options.narrow ?? true;
    const stop = watchTabHistory({
      router,
      thread: KEY,
      narrow: narrowWindow,
      activate: (tab) => change({ type: "activate", tab }),
      tags,
      input,
      isWide: () => !narrowWindow,
    });
    return { [Symbol.dispose]: stop };
  };
  const at = (router: AnyRouter) => ({
    index: router.history.location.state.__TSR_index,
    pathname: router.history.location.pathname,
    tab: tags.get(router.history.location.state)?.tab ?? null,
  });
  const back = async (router: AnyRouter) => {
    router.history.back();
    await settle();
  };
  const forward = async (router: AnyRouter) => {
    router.history.forward();
    await settle();
  };
  // useCloseAppModal: back to the entry before the return entry, then navigate to the thread.
  const closeAppModal = async (router: AnyRouter, returnIndex: number) => {
    const steps = at(router).index - returnIndex;
    const unsubscribe = router.history.subscribe(() => {
      unsubscribe();
      router.updateLatestLocation();
      void router.navigate({ href: THREAD });
    });
    noteAppModalClose(router.history, THREAD);
    router.history.go(-(steps + 1));
    await settle();
  };

  it("pushes each narrow tab change and steps Back through them, then out of the thread", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);

    await press(A);
    await press(B);
    expect(at(router)).toEqual({ index: 3, pathname: THREAD, tab: B });
    expect(tags.get(router.history.location.state)).toEqual(pushed(B));

    await back(router);
    expect(shown()).toBe(A);
    await back(router);
    expect([shown(), at(router)]).toEqual([
      PRIMARY_CHAT,
      { index: 1, pathname: THREAD, tab: "chat" },
    ]);
    await back(router);
    expect(at(router).pathname).toBe(OTHER);
    expect(router.history.length).toBe(4);
  });

  it("skips the entry of a tab a close already shows", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    await press(B);
    await press(A);

    store().closeSurface(ref, A);
    await settle();
    expect([shown(), at(router).index]).toEqual([B, 3]);

    await back(router);
    expect([shown(), at(router).index]).toEqual([PRIMARY_CHAT, 1]);
  });

  it("skips closed tabs going Back and Forward", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    await press(A);
    await press(B);
    await press(C);
    store().closeSurface(ref, A);
    store().closeSurface(ref, B);

    await back(router);
    expect([shown(), at(router).index]).toEqual([PRIMARY_CHAT, 1]);

    await forward(router);
    expect([shown(), at(router).index]).toEqual([C, 4]);
  });

  it("steps Forward to an open tab and stays at the end", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    await press(A);
    await press(B);
    await back(router);
    await back(router);

    await forward(router);
    expect(shown()).toBe(A);

    store().closeSurface(ref, B);
    await forward(router);
    expect([shown(), at(router).index]).toEqual([A, 3]);
  });

  it("pushes nothing for a restore, a reveal or an automatic open", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    await press(A);
    await back(router);
    expect(router.history.length).toBe(3);

    store().revealSurface(ref, B);
    store().open(ref, "diff", true);
    await settle();
    expect(router.history.length).toBe(3);
    expect(at(router).index).toBe(1);
  });

  it("pushes the tab the user chose when a reveal shows another before the write", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    input.dispatchEvent(new Event("pointerdown"));
    store().activateSurface(ref, A);
    store().revealSurface(ref, B);
    await settle();
    expect([shown(), at(router)]).toEqual([B, { index: 2, pathname: THREAD, tab: A }]);

    await back(router);
    expect(shown()).toBe(PRIMARY_CHAT);
    await forward(router);
    expect([shown(), at(router).index]).toEqual([A, 2]);
  });

  it("drops a pending push when Back or Forward arrives first", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    await press(A);
    await press(B);
    await back(router);

    store().activateSurface(ref, C);
    router.history.forward();
    await settle();
    expect([router.history.length, at(router)]).toEqual([
      4,
      { index: 3, pathname: THREAD, tab: B },
    ]);
  });

  it("pushes nothing when wide, and a wide Back passes the entries left from narrow", async () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router, { narrow: false });
      await press(A);
      await press(B);
      expect(at(router).index).toBe(1);
    }
    {
      using _watch = watching(router);
      await press(C);
      await press(A);
    }
    using _wide = watching(router, { narrow: false });
    expect(at(router).index).toBe(3);

    await back(router);
    expect(at(router)).toEqual({ index: 0, pathname: OTHER, tab: null });
    expect(shown()).toBe(A);
  });

  it("steps wide Back and Forward as if the pushed entries were not there", async () => {
    // [other, thread, A, B, thread#quote, C, A]: two runs of pushes, each after its base entry.
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      await press(A);
      await press(B);
      router.history.push(`${THREAD}#${quoteHash(ref.threadId)}`);
      await press(C);
      await press(A);
    }
    using _wide = watching(router, { narrow: false });
    expect(at(router).index).toBe(6);

    // The user is on the quote entry, the second run's base, so Back reaches the first base.
    await back(router);
    expect(at(router).index).toBe(1);
    await forward(router);
    expect(at(router).index).toBe(4);
  });

  it("stops a wide Back at the base when it started on an entry it did not push", async () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      await press(A);
      await press(B);
      // A second click on the open thread.
      router.history.push(THREAD);
    }
    using _wide = watching(router, { narrow: false });
    expect(at(router).index).toBe(4);

    await back(router);
    expect(at(router).index).toBe(1);
  });

  it("wide Back from another thread stops at the entry a run was pushed from, with no view of its thread", async () => {
    // [other, thread, thread#quote, A, other]: no view of the thread runs after it is left.
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      router.history.push(`${THREAD}#${quoteHash(ref.threadId)}`);
      await press(A);
    }
    router.history.push(OTHER);
    narrowWindow = false;
    expect(at(router).index).toBe(4);

    await back(router);
    expect([at(router).index, router.history.location.hash]).toEqual([
      2,
      `#${quoteHash(ref.threadId)}`,
    ]);
    await back(router);
    expect(at(router)).toEqual({ index: 1, pathname: THREAD, tab: "chat" });
  });

  it("reports whether only our tab pushes moved history since a location", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    const start = router.history.location;
    await press(A);
    const afterA = router.history.location;
    await press(B);
    // A reopen may wait from the start of the run or from any entry the run pushed.
    expect([start, afterA].map(onlyOwnTabPushesSince)).toEqual([true, true]);

    await back(router);
    const backAtA = router.history.location;
    expect([start, afterA, backAtA].map(onlyOwnTabPushesSince)).toEqual([false, false, false]);
    await press(C);
    expect(onlyOwnTabPushesSince(backAtA)).toBe(true);

    router.history.push(OTHER);
    await settle();
    expect(onlyOwnTabPushesSince(backAtA)).toBe(false);
  });

  it("ends the run of our pushes when Settings closes, though it pushes a tab entry", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    await press(A);
    const beforeSettings = router.history.location;
    router.history.push("/settings");
    await closeAppModal(router, beforeSettings.state.__TSR_index);
    expect(tags.get(router.history.location.state)).toEqual(pushed(A));

    expect(onlyOwnTabPushesSince(beforeSettings)).toBe(false);
  });

  it("classifies each history event before listeners that subscribe after the first watcher", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    const steps: [string, boolean][] = [];
    const unsubscribe = router.history.subscribe(({ action, location }) => {
      steps.push([action.type, isWorkAreaTabStep(location)]);
    });
    using _listen = { [Symbol.dispose]: unsubscribe };
    await press(A);
    await press(B);
    await press(C);
    store().closeSurface(ref, B);
    await settle();
    // Back shows A over the closed B, then the starting tab, then leaves the thread.
    await back(router);
    await back(router);
    await back(router);
    await forward(router);
    router.history.push(THREAD);
    await settle();

    expect(steps).toEqual([
      ["PUSH", true],
      ["PUSH", true],
      ["PUSH", true],
      ["BACK", true],
      ["BACK", true],
      ["BACK", true],
      ["BACK", false],
      ["FORWARD", false],
      ["PUSH", false],
    ]);
  });

  it("pushes a fresh entry when Settings closes, so Back, Forward and Forward again keep their tabs", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    await press(A);
    await press(B);
    const returnIndex = at(router).index;
    router.history.push("/settings");
    await press(C);
    expect(at(router)).toEqual({ index: returnIndex + 1, pathname: "/settings", tab: null });

    await closeAppModal(router, returnIndex);
    expect([shown(), at(router), router.history.length]).toEqual([
      C,
      { index: 3, pathname: THREAD, tab: C },
      4,
    ]);
    expect(tags.get(router.history.location.state)).toEqual(pushed(C));

    await back(router);
    expect([shown(), at(router).index]).toEqual([A, 2]);
    await forward(router);
    await forward(router);
    expect([shown(), at(router)]).toEqual([C, { index: 3, pathname: THREAD, tab: C }]);
  });

  it("pushes a fresh entry when Settings closes in a wide window, so Forward has no Settings", async () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      await press(A);
    }
    using _wide = watching(router, { narrow: false });
    const returnIndex = at(router).index;
    router.history.push("/settings");

    await closeAppModal(router, returnIndex);
    expect([at(router), router.history.length]).toEqual([
      { index: 2, pathname: THREAD, tab: A },
      3,
    ]);
    expect(tags.get(router.history.location.state)).toEqual(pushed(A));
    // One wide Back passes the fresh entry and the narrow run, and leaves the thread.
    await back(router);
    expect(at(router).pathname).not.toBe(THREAD);
  });

  it("pushes nothing for a GO the Close did not start, so Forward keeps its entries", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    await press(A);
    await press(B);
    router.history.push("/settings");

    // A pick two entries back in the browser's Back menu.
    router.history.go(-2);
    await settle();
    expect([at(router), router.history.length]).toEqual([
      { index: 2, pathname: THREAD, tab: A },
      5,
    ]);
    router.history.go(2);
    await settle();
    expect(at(router)).toEqual({ index: 4, pathname: "/settings", tab: null });
  });

  it("forgets a Close at the next history event", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    noteAppModalClose(router.history, THREAD);
    router.history.push("/settings");

    router.history.go(-1);
    await settle();
    expect([at(router).index, router.history.length]).toEqual([1, 3]);
  });

  it("pushes nothing when a Close returns to a page other than the entry it lands on", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    router.history.push("/settings");
    noteAppModalClose(router.history, OTHER);

    router.history.go(-1);
    await settle();
    expect([at(router), router.history.length]).toEqual([
      { index: 1, pathname: THREAD, tab: "chat" },
      3,
    ]);
  });

  it("pushes a Close's entry under the whiteboard build's basepath", async () => {
    const router = threadRouter([`/chat${OTHER}`, `/chat${THREAD}`], "/chat");
    using _watch = watching(router);
    await press(A);
    router.history.push("/chat/settings");
    // The Close names its page as the router sees it, without the basepath.
    noteAppModalClose(router.history, THREAD);

    router.history.go(-2);
    await settle();
    expect([at(router), router.history.length]).toEqual([
      { index: 2, pathname: `/chat${THREAD}`, tab: A },
      3,
    ]);
    expect(tags.get(router.history.location.state)).toEqual(pushed(A));
  });

  it("tags a same-path entry another click pushes, and Back skips it", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    await press(A);
    router.history.push(THREAD);
    await settle();
    expect(at(router)).toEqual({ index: 3, pathname: THREAD, tab: A });
    expect(tags.get(router.history.location.state)).toEqual(entry(A));

    await back(router);
    expect([shown(), at(router).index]).toEqual([PRIMARY_CHAT, 1]);
  });

  it("keeps history state free of tags, so a same-path navigate adds no entry", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    await press(A);
    router.updateLatestLocation();

    await router.navigate({ href: THREAD });
    expect([router.history.length, at(router)]).toEqual([
      3,
      { index: 2, pathname: THREAD, tab: A },
    ]);
  });

  it("retags a side-chat quote for its reveal and pushes later changes without the quote", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    const hash = quoteHash(SIDE);
    router.history.push(`${THREAD}#${hash}`, { assistantCitationActivation: "quote-1" });
    await revealSideChat();
    expect([shown(), at(router)]).toEqual([
      SIDE_TAB,
      { index: 2, pathname: THREAD, tab: SIDE_TAB },
    ]);

    await press(A);
    await press(B);
    expect([at(router), router.history.location.hash]).toEqual([
      { index: 4, pathname: THREAD, tab: B },
      "",
    ]);

    await back(router);
    expect(shown()).toBe(A);
    await back(router);
    expect([shown(), at(router).index, router.history.location.hash]).toEqual([
      SIDE_TAB,
      2,
      `#${hash}`,
    ]);
    await back(router);
    expect([shown(), at(router).index]).toEqual([PRIMARY_CHAT, 1]);
    await forward(router);
    expect([shown(), at(router).index, router.history.length]).toEqual([SIDE_TAB, 2, 5]);
  });

  it("retags a quote entry for a reply tab it reveals", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    const hash = quoteHash(ref.threadId);
    const reply = replyTabId(ref, "assistant-1");
    router.history.push(`${THREAD}#${hash}`, { assistantCitationActivation: "quote-1" });
    const restoreView = publishWorkAreaView({ narrow: true, size: null });
    change({ type: "open-reply", thread: ref, first: "assistant-1", reveal: "quote" });
    restoreView();
    await settle();
    expect([shown(), at(router), router.history.location.hash]).toEqual([
      reply,
      { index: 2, pathname: THREAD, tab: reply },
      `#${hash}`,
    ]);

    await press(A);
    await back(router);
    expect([shown(), at(router).index, router.history.length]).toEqual([reply, 2, 4]);
  });

  it("pushes a switch to the cited side-chat tab made after input", async () => {
    store().openThread(ref, SIDE);
    store().activateSurface(ref, A);
    const router = threadRouter([OTHER, `${THREAD}#${quoteHash(SIDE)}`]);
    using _watch = watching(router);
    expect(at(router)).toEqual({ index: 1, pathname: THREAD, tab: A });

    await press(SIDE_TAB);
    expect(at(router)).toEqual({ index: 2, pathname: THREAD, tab: SIDE_TAB });
    await back(router);
    expect([shown(), at(router).index]).toEqual([A, 1]);
  });

  it("pushes a change made on a main-chat quote", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    const hash = quoteHash(ref.threadId);
    router.history.push(`${THREAD}#${hash}`, { assistantCitationActivation: "quote-1" });
    await press(A);
    expect([at(router), router.history.location.hash]).toEqual([
      { index: 3, pathname: THREAD, tab: A },
      "",
    ]);

    await back(router);
    expect([shown(), at(router).index, router.history.location.hash]).toEqual([
      PRIMARY_CHAT,
      2,
      `#${hash}`,
    ]);
  });

  it("leaves Back onto a quote entry whose tab was closed to the quote", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    router.history.push(`${THREAD}#${quoteHash(SIDE)}`, { assistantCitationActivation: "quote-1" });
    await revealSideChat();
    await press(A);
    store().closeSurface(ref, SIDE_TAB);
    await settle();

    await back(router);
    expect([shown(), at(router)]).toEqual([A, { index: 2, pathname: THREAD, tab: SIDE_TAB }]);
    // The quote's own reveal runs again here, and it only retags the entry.
    await revealSideChat();
    expect([shown(), at(router).index, router.history.length]).toEqual([SIDE_TAB, 2, 4]);
  });

  it.each([{ narrow: true }, { narrow: false }])(
    "steps Back from a main-chat quote to the entry before it, narrow $narrow",
    async ({ narrow }) => {
      const router = threadRouter([OTHER, THREAD]);
      // A narrow visit tags the entry before the quote.
      watching(router)[Symbol.dispose]();
      using _watch = watching(router, { narrow });
      router.history.push(`${THREAD}#${quoteHash(ref.threadId)}`, {
        assistantCitationActivation: "quote-1",
      });
      await settle();

      await back(router);
      expect([shown(), at(router)]).toEqual([
        PRIMARY_CHAT,
        { index: 1, pathname: THREAD, tab: "chat" },
      ]);
    },
  );

  it("keeps the key of a quote entry opened without an activation", async () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    router.history.push(`${THREAD}#${quoteHash(SIDE)}`);
    const { __TSR_key: key } = router.history.location.state;
    await revealSideChat();
    expect(router.history.location.state.__TSR_key).toBe(key);

    await press(A);
    await back(router);
    expect([shown(), router.history.location.state.__TSR_key]).toEqual([SIDE_TAB, key]);
  });

  it("steps Back from a first side-chat quote to the tab shown before it", async () => {
    store().activateSurface(ref, A);
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    router.history.push(`${THREAD}#${quoteHash(SIDE)}`, { assistantCitationActivation: "quote-1" });
    await revealSideChat();

    await back(router);
    expect([shown(), at(router)]).toEqual([A, { index: 1, pathname: THREAD, tab: A }]);
  });

  it("Back passes all three entries of a deleted thread in one press", async () => {
    tags = tabHistoryTags;
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      await press(A);
      await press(B);
    }
    markTabHistoryThreadDeleted(ref);
    router.history.push(THIRD);
    expect(at(router).index).toBe(4);

    await back(router);
    expect(at(router)).toEqual({ index: 0, pathname: OTHER, tab: null });
  });

  it("drops a pending push when the thread changes", async () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      store().activateSurface(ref, A);
    }
    await settle();
    expect(router.history.length).toBe(2);

    using _watch = watching(router);
    store().activateSurface(ref, B);
    router.history.push(OTHER);
    await settle();
    expect(at(router)).toEqual({ index: 2, pathname: OTHER, tab: null });
  });

  it("pushes nothing on a draft route", async () => {
    const router = threadRouter([OTHER, "/draft/draft-1"]);
    using _watch = watching(router);
    await press(A);
    expect(router.history.length).toBe(2);
  });

  it("pushes under the whiteboard build's basepath", async () => {
    const router = threadRouter([`/chat${OTHER}`, `/chat${THREAD}`], "/chat");
    using _watch = watching(router);
    await press(A);
    expect(at(router)).toEqual({ index: 2, pathname: `/chat${THREAD}`, tab: A });

    await back(router);
    expect([shown(), at(router).tab]).toEqual([PRIMARY_CHAT, "chat"]);
  });

  it("keeps tags across a reload", async () => {
    const storage = memoryStorage();
    tags = createTabTags(() => storage);
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      await press(A);
      await press(B);
    }

    // A reload keeps the history entries and session storage, and starts a new tag map.
    tags = createTabTags(() => storage);
    using _watch = watching(router);
    await back(router);
    expect(shown()).toBe(A);
    await back(router);
    expect(shown()).toBe(PRIMARY_CHAT);
  });
});
