import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  decideMove,
  type Move,
  type MoveDecision,
  planWrite,
  readTabTag,
  type TabChange,
  type TabTag,
  userTabChange,
} from "./tabHistory.logic";
import { asTabId, PRIMARY_CHAT, replyTabId, type TabId } from "./workArea.logic";
import { change, onePane, other, ref, resetWorkAreaStore, store, third } from "./workAreaTestKit";
import { publishWorkAreaView } from "./workAreaView";

const KEY = scopedThreadKey(ref);
const OKEY = scopedThreadKey(other);
const A = asTabId("file:a.ts");
const B = asTabId("file:b.ts");
const C = asTabId("file:c.ts");
const tag = (tab: string, thread = KEY): TabTag => ({ thread, tab: asTabId(tab) });

beforeEach(resetWorkAreaStore);

describe("readTabTag", () => {
  it.each([
    { state: { workAreaTab: { thread: KEY, tab: "chat" } }, read: tag("chat") },
    { state: { __TSR_index: 3, workAreaTab: { thread: KEY, tab: "chat" } }, read: tag("chat") },
    { state: undefined, read: null },
    { state: null, read: null },
    { state: "chat", read: null },
    { state: { __TSR_index: 0 }, read: null },
    { state: { workAreaTab: "chat" }, read: null },
    { state: { workAreaTab: { thread: KEY } }, read: null },
    { state: { workAreaTab: { thread: KEY, tab: 3 } }, read: null },
    { state: { workAreaTab: { thread: null, tab: "chat" } }, read: null },
  ])("reads $state as $read", ({ state, read }) => {
    expect(readTabTag(state)).toEqual(read);
  });
});

describe("userTabChange", () => {
  const terminal = () =>
    store().byThreadKey[KEY]!.surfaces.find((surface) => surface.kind === "terminal")!.id;
  // [chat, a.ts, terminal] in one pane, a.ts shown.
  const after = (act: () => void, findOpen = false) => {
    resetWorkAreaStore();
    publishWorkAreaView({ narrow: true, size: null });
    onePane("a.ts");
    store().openTerminal(ref, "term-1");
    store().activateSurface(ref, "file:a.ts");
    const prev = store();
    act();
    return userTabChange(prev, store(), KEY, findOpen);
  };

  it.each([
    { name: "a display-tab press", act: () => change({ type: "activate", tab: PRIMARY_CHAT }) },
    { name: "a surface-tab press", act: () => store().activateSurface(ref, terminal()) },
    { name: "an open", act: () => store().openFile(ref, "b.ts") },
  ])("reads $name as a switch from the shown tab, with Find open or not", ({ act }) => {
    expect(after(act)).toEqual({ type: "switch", from: A });
    expect(after(act, true)).toEqual({ type: "switch", from: A });
  });

  it("reads a close of the shown tab as a close, with Find open or not", () => {
    expect(after(() => store().closeSurface(ref, "file:a.ts"))).toEqual({ type: "close" });
    expect(after(() => store().closeSurface(ref, "file:a.ts"), true)).toEqual({ type: "close" });
  });

  const REPLY = replyTabId(ref, "m-1");
  // [chat, reply] in one strip, `from` shown.
  const between = (from: TabId, act: () => void, findOpen: boolean) => {
    resetWorkAreaStore();
    publishWorkAreaView({ narrow: true, size: null });
    change({ type: "open-reply", thread: ref, first: "m-1", reveal: "find" });
    change({ type: "activate", tab: from });
    const prev = store();
    act();
    return userTabChange(prev, store(), KEY, findOpen);
  };

  it.each([
    { name: "Chat to a reply", from: PRIMARY_CHAT, to: REPLY },
    { name: "a reply to Chat", from: REPLY, to: PRIMARY_CHAT },
  ])("ignores a Find step from $name only while Find is open", ({ from, to }) => {
    const step = () => change({ type: "activate", tab: to });
    expect(between(from, step, true)).toBeNull();
    expect(between(from, step, false)).toEqual({ type: "switch", from });
  });

  it("reads a close of a reply that shows Chat as a close while Find is open", () => {
    const close = () => change({ type: "close", tab: REPLY });
    expect(between(REPLY, close, true)).toEqual({ type: "close" });
  });

  it.each([
    { name: "a close of a hidden tab", act: () => store().closeSurface(ref, terminal()) },
    { name: "an agent reveal", act: () => store().revealSurface(ref, terminal()) },
    { name: "an automatic open", act: () => store().open(ref, "diff", true) },
    { name: "a user mark alone", act: () => void store().markUserAction(ref) },
    { name: "another thread's open", act: () => store().openFile(other, "b.ts") },
    { name: "a thread removal", act: () => store().removeThread(ref) },
  ])("ignores $name", ({ act }) => {
    expect(after(act)).toBeNull();
  });

  it("ignores a revision that went down", () => {
    const prev = { ...store(), userActionRevisionByThreadKey: { [KEY]: 2 } };
    store().openFile(ref, "a.ts");
    const next = { ...store(), userActionRevisionByThreadKey: { [KEY]: 1 } };
    expect(userTabChange(prev, next, KEY, false)).toBeNull();
  });

  it("counts the first open of a thread with no record", () => {
    const prev = store();
    store().openFile(ref, "a.ts");
    expect(userTabChange(prev, store(), KEY, false)).toEqual({
      type: "switch",
      from: PRIMARY_CHAT,
    });
  });
});

describe("planWrite", () => {
  const entry = (current: TabTag | null, href = "/e/t") => ({ href, tag: current });
  const switched: TabChange = { type: "switch", from: PRIMARY_CHAT };
  const closed: TabChange = { type: "close" };
  const quote = "/e/t#assistant-citation=abc";

  it.each([
    { name: "retags an untagged start entry", current: entry(null), retag: tag("chat") },
    { name: "keeps an entry tagged with the tab left", current: entry(tag("chat")), retag: null },
    { name: "retags a stale entry", current: entry(tag(B)), retag: tag("chat") },
    { name: "retags another thread's tag", current: entry(tag("chat", OKEY)), retag: tag("chat") },
    { name: "never retags a quote entry", current: entry(null, quote), retag: null },
    { name: "never retags a tagged quote entry", current: entry(tag(B), quote), retag: null },
  ])("switch: $name, then pushes the hashless href", ({ current, retag }) => {
    expect(planWrite(current, KEY, switched, A)).toEqual({
      retag,
      push: { href: "/e/t", tag: tag(A) },
    });
  });

  it("switch: keeps a query and a hash that is not a quote", () => {
    const href = "/e/t?q=1#other";
    expect(planWrite(entry(null, href), KEY, switched, A)?.push?.href).toBe(href);
  });

  it("switch: writes nothing when the shown tab came back", () => {
    expect(planWrite(entry(null), KEY, { type: "switch", from: A }, A)).toBeNull();
  });

  it("switch: writes nothing when the entry already holds the new tab", () => {
    expect(planWrite(entry(tag(A)), KEY, switched, A)).toBeNull();
  });

  const retagB = { retag: tag(B), push: null };
  it.each([
    { name: "retags an untagged entry", current: entry(null), plan: retagB },
    { name: "retags the closed tab's entry", current: entry(tag(A)), plan: retagB },
    { name: "keeps an entry tagged with the shown tab", current: entry(tag(B)), plan: null },
    { name: "never tags a quote entry", current: entry(null, quote), plan: null },
  ])("close: $name", ({ current, plan }) => {
    expect(planWrite(current, KEY, closed, B)).toEqual(plan);
  });
});

describe("decideMove", () => {
  const skip: MoveDecision = { type: "skip" };
  const none: MoveDecision = { type: "none" };
  const show: MoveDecision = { type: "show", tab: A };
  const TKEY = scopedThreadKey(third);
  it.each<[string, Partial<Move> & { thread?: string }, MoveDecision]>([
    ["shows an open tab", {}, show],
    ["shows an open tab when the move started elsewhere", { sameOrigin: false }, show],
    ["skips a closed tab", { tag: tag(C) }, skip],
    [
      "skips a closed tab when the move started elsewhere",
      { tag: tag(C), sameOrigin: false },
      skip,
    ],
    ["skips the shown tab when the move started here", { tag: tag(B) }, skip],
    [
      "keeps the shown tab when the move started elsewhere",
      { tag: tag(B), sameOrigin: false },
      none,
    ],
    ["ignores an untagged entry", { tag: null }, none],
    ["ignores another thread's closed tab", { tag: tag(A, OKEY) }, none],
    ["ignores another thread's open tab", { tag: tag(C, OKEY) }, none],
    ["skips a closed tab of a thread with no record", { tag: tag(A, TKEY), thread: TKEY }, skip],
    [
      "skips the shown Chat of a thread with no record",
      { tag: tag("chat", TKEY), thread: TKEY },
      skip,
    ],
  ])("%s", (_name, { thread = KEY, ...over }, decision) => {
    // The owner shows b.ts of [chat, a.ts, b.ts]; the other thread holds c.ts.
    onePane("a.ts", "b.ts");
    store().openFile(other, "c.ts");
    const move = { tag: tag(A), sameOrigin: true, ...over };
    expect(decideMove(move, thread, store().byThreadKey)).toEqual(decision);
  });
});
