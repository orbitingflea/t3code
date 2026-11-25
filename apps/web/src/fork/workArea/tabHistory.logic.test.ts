import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { HistoryLocation, HistoryState } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import {
  carryTag,
  type LandingInput,
  MAX_WALK,
  planLanding,
  planMove,
  readTabTag,
  type TabTag,
} from "./tabHistory.logic";
import { asTabId } from "./workArea.logic";

const env = EnvironmentId.make("env-1");
const owner = scopeThreadRef(env, ThreadId.make("thread-owner"));
const other = scopeThreadRef(env, ThreadId.make("thread-other"));
const chat = asTabId("chat");
const files = asTabId("files");
const diff = asTabId("diff");
const tag = (tab = files, ref = owner, id = "s-1"): TabTag => ({ ...ref, tab, id });

describe("readTabTag", () => {
  it("parses a tag and keeps only its own fields", () => {
    expect(readTabTag({ __TSR_index: 2, workAreaTab: { ...tag(), extra: 1 } })).toEqual(tag());
  });

  it.each([
    ["no state", undefined],
    ["no tag", { __TSR_index: 0 }],
    ["a tag missing its id", { workAreaTab: { ...owner, tab: "files" } }],
    ["a tag with a number for a field", { workAreaTab: { ...owner, tab: 3, id: "s-1" } }],
    ["a tag that is a string", { workAreaTab: "files" }],
  ])("reads %s as untagged", (_name, state) => {
    expect(readTabTag(state)).toBeNull();
  });
});

describe("planMove", () => {
  it.each<[string, TabTag | null, typeof chat, typeof chat, ReturnType<typeof planMove>]>([
    ["no change of tab", null, chat, chat, null],
    ["an untagged entry", null, chat, files, { retag: chat, push: files }],
    ["an entry that names the tab left", tag(chat), chat, files, { retag: null, push: files }],
    // An agent revealed `chat` over the entry's `files`: the user left `chat`, so it is the stop.
    ["an entry naming another tab", tag(files), chat, diff, { retag: chat, push: diff }],
    ["another owner's tag", tag(chat, other), chat, files, { retag: chat, push: files }],
  ])("for %s", (_name, current, left, to, expected) => {
    expect(planMove(current, owner, left, to)).toEqual(expected);
  });
});

describe("planLanding", () => {
  const input = (over: Partial<LandingInput>): LandingInput => ({
    last: "pop",
    direction: -1,
    moved: true,
    tag: tag(files),
    gonePath: false,
    showable: true,
    shown: chat,
    samePath: true,
    atStart: false,
    steps: 0,
    ...over,
  });

  it.each<[string, Partial<LandingInput>, ReturnType<typeof planLanding>]>([
    ["shows an open tab the pop landed on", {}, { kind: "show", tag: tag(files) }],
    ["shows it across threads", { samePath: false }, { kind: "show", tag: tag(files) }],
    ["keeps the screen after an app write", { last: "write" }, { kind: "stay" }],
    ["keeps the screen after a pop that did not move", { moved: false }, { kind: "stay" }],
    ["steps past a deleted thread's entry", { gonePath: true }, { kind: "step", delta: -1 }],
    ["steps past a closed tab", { showable: false }, { kind: "step", delta: -1 }],
    [
      "keeps a closed tab that came from another page",
      { showable: false, samePath: false },
      { kind: "stay" },
    ],
    ["steps on forward too", { showable: false, direction: 1 }, { kind: "step", delta: 1 }],
    ["steps past a repeat of the shown tab", { shown: files }, { kind: "step", delta: -1 }],
    [
      "keeps a repeat that came from another page",
      { shown: files, samePath: false },
      { kind: "stay" },
    ],
    ["keeps an untagged entry", { tag: null }, { kind: "stay" }],
    ["never steps back from the first entry", { showable: false, atStart: true }, { kind: "stay" }],
    [
      "steps forward from the first entry",
      { showable: false, atStart: true, direction: 1 },
      { kind: "step", delta: 1 },
    ],
    ["stops a walk at its limit", { showable: false, steps: MAX_WALK }, { kind: "stay" }],
    ["does not step without a direction", { showable: false, direction: 0 }, { kind: "stay" }],
  ])("%s", (_name, over, expected) => {
    expect(planLanding(input(over))).toEqual(expected);
  });
});

describe("carryTag", () => {
  const current = (
    href: string,
    state: HistoryLocation["state"] = { workAreaTab: tag(), __TSR_index: 3 },
  ) => ({ href, state });
  const next = <S extends HistoryState>(href: string, state: S) => ({
    href,
    pathname: href.split("#")[0]!,
    state,
  });

  it("gives a navigation to the current URL with the entry's own state the entry's tag", () => {
    const from = current("/env-1/thread-owner", {
      workAreaTab: tag(),
      __TSR_index: 3,
      reopenedViewId: "v",
    });
    const state: HistoryState = { reopenedViewId: "v" };
    const carried = carryTag(from, next("/env-1/thread-owner/", state), true);
    expect(carried).toEqual({ reopenedViewId: "v", workAreaTab: tag() });
    expect(carried?.workAreaTab).toBe(from.state.workAreaTab);
  });

  it("gives a plain navigation to the current URL all of the current entry's own state", () => {
    const from = current("/env-1/thread-owner", {
      workAreaTab: tag(),
      __TSR_index: 3,
      __TSR_key: "k-3",
      key: "k-3",
      __hashScrollIntoViewOptions: true,
      reopenedViewId: "v",
    });
    const state: Partial<HistoryLocation["state"]> = { __TSR_key: "k-4", key: "k-4" };
    const carried = carryTag(from, next("/env-1/thread-owner/", state), true);
    expect(carried).toEqual({
      __TSR_key: "k-4",
      key: "k-4",
      reopenedViewId: "v",
      workAreaTab: tag(),
    });
    expect(carried?.workAreaTab).toBe(from.state.workAreaTab);
  });

  it("gives a plain navigation in a wide window only the tag, so the router dedupes it as on base", () => {
    const own = { workAreaTab: tag(), __TSR_index: 3, reopenedViewId: "v" };
    expect(
      carryTag(current("/env-1/thread-owner", own), next("/env-1/thread-owner", {}), false),
    ).toBe(null);
    const tagOnly = current("/env-1/thread-owner", { workAreaTab: tag(), __TSR_index: 3 });
    expect(carryTag(tagOnly, next("/env-1/thread-owner", {}), false)).toEqual({
      workAreaTab: tag(),
    });
  });

  it("gives a replace onto the tag owner's thread page the tag, as a sent draft's redirect", () => {
    const draft = current("/draft/d-1");
    const redirect = { ...next("/env-1/thread-owner", {}), replace: true };
    expect(carryTag(draft, redirect, true)).toEqual({ workAreaTab: tag() });
    expect(carryTag(draft, redirect, false)).toEqual({ workAreaTab: tag() });
  });

  it.each([
    ["a push onto the owner's page", "/env-1/thread-owner", false],
    ["a replace onto another thread's page", "/env-1/thread-other", true],
    ["a replace onto a page that is no thread's", "/", true],
  ])("leaves %s from another URL alone", (_name, href, replace) => {
    expect(carryTag(current("/draft/d-1"), { ...next(href, {}), replace }, true)).toBeNull();
  });

  it.each([
    ["another URL", current("/env-1/thread-owner"), "/env-1/thread-owner#assistant-citation=x", {}],
    [
      "a navigation with its own tag",
      current("/env-1/thread-owner"),
      "/env-1/thread-owner",
      { workAreaTab: tag(diff, owner, "s-2") },
    ],
    [
      // A quote link opened again makes a new entry, which must not claim the tab.
      "a navigation to a new entry with other state",
      current("/env-1/thread-owner#assistant-citation=x", {
        workAreaTab: tag(),
        __TSR_index: 3,
        assistantCitationActivation: "old",
      }),
      "/env-1/thread-owner#assistant-citation=x",
      { assistantCitationActivation: "new" },
    ],
    [
      "an untagged current entry",
      { href: "/env-1/thread-owner", state: {} },
      "/env-1/thread-owner",
      {},
    ],
  ])("leaves %s alone", (_name, from, href, state) => {
    expect(carryTag(from, next(href, state), true)).toBeNull();
  });
});
