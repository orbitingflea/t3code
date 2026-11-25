import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { closeThreadFind, openThreadFind } from "~/components/chat/threadFindStore";

import { watchTabHistory } from "./tabHistory";
import { readTabTag } from "./tabHistory.logic";
import { asTabId, focusedTab, PRIMARY_CHAT, replyTabId } from "./workArea.logic";
import { change, layout, onePane, other, ref, resetWorkAreaStore, store } from "./workAreaTestKit";
import { publishWorkAreaView } from "./workAreaView";

const KEY = scopedThreadKey(ref);
const OKEY = scopedThreadKey(other);
const THREAD = `/${ref.environmentId}/${ref.threadId}`;
const OTHER = `/${other.environmentId}/${other.threadId}`;
const ISSUES = "/issues"; // a page with no work area
const A = asTabId("file:a.ts");
const B = asTabId("file:b.ts");
const C = asTabId("file:c.ts");

function threadRouter(entries: readonly string[], basepath?: string) {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const thread = createRoute({ getParentRoute: () => chat, path: "$environmentId/$threadId" });
  const draft = createRoute({ getParentRoute: () => chat, path: "draft/$draftId" });
  return createRouter({
    routeTree: root.addChildren([chat.addChildren([thread, draft])]),
    history: createMemoryHistory({ initialEntries: [...entries] }),
    ...(basepath === undefined ? {} : { basepath }),
  });
}

beforeEach(() => {
  resetWorkAreaStore();
  vi.useFakeTimers();
  // [chat, a.ts, b.ts, c.ts], Chat shown.
  onePane("a.ts", "b.ts", "c.ts");
  change({ type: "activate", tab: PRIMARY_CHAT });
});
afterEach(() => {
  closeThreadFind();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const shown = () => focusedTab(layout());
const settle = () => vi.runAllTimers();
const press = (tab: string) => {
  store().activateSurface(ref, tab);
  settle();
};
const watching = (router: AnyRouter, thread = KEY): Disposable => {
  const stop = watchTabHistory(router, thread, (tab) => change({ type: "activate", tab }));
  return { [Symbol.dispose]: stop };
};
const at = (router: AnyRouter) => ({
  index: router.history.location.state.__TSR_index,
  length: router.history.length,
  tab: readTabTag(router.history.location.state)?.tab ?? null,
});
const back = (router: AnyRouter) => {
  router.history.back();
  settle();
};
const forward = (router: AnyRouter) => {
  router.history.forward();
  settle();
};

describe("watchTabHistory", () => {
  it("pushes each switch and steps Back through them, then out of the thread", () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    press(A);
    press(B);
    expect(at(router)).toEqual({ index: 3, length: 4, tab: B });

    back(router);
    expect(shown()).toBe(A);
    back(router);
    expect([shown(), at(router)]).toEqual([PRIMARY_CHAT, { index: 1, length: 4, tab: "chat" }]);
    back(router);
    expect(router.history.location.pathname).toBe(OTHER);
  });

  it.each([
    { name: "Back", start: (_router: AnyRouter) => {}, step: back, tab: PRIMARY_CHAT, index: 1 },
    {
      name: "Forward",
      start: (router: AnyRouter) => {
        back(router);
        back(router);
      },
      step: forward,
      tab: B,
      index: 3,
    },
  ])(
    "drops a switch queued before a $name that skips a closed tab",
    ({ start, step, tab, index }) => {
      const router = threadRouter([OTHER, THREAD]);
      using _watch = watching(router);
      press(A);
      press(B);
      start(router);
      store().closeSurface(ref, A);
      store().activateSurface(ref, C);
      step(router); // lands on the closed a.ts entry
      expect([shown(), at(router)]).toEqual([tab, { index, length: 4, tab }]);
    },
  );

  it("drops a switch queued before a history jump", () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    press(A);
    press(B);
    press(C);
    change({ type: "activate", tab: PRIMARY_CHAT });
    router.history.go(-2);
    settle();
    expect(at(router)).toEqual({ index: 2, length: 5, tab: A });
  });

  it("drops a switch queued before its thread is removed", () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    press(A);
    store().activateSurface(ref, B);
    store().removeThread(ref);
    settle();
    expect(at(router)).toEqual({ index: 2, length: 3, tab: A });
  });

  it("retags the entry on a close, so Back then Forward returns to the tab it fell back to", () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    press(A);
    store().closeSurface(ref, A);
    settle();
    expect([shown(), at(router)]).toEqual([B, { index: 2, length: 3, tab: B }]);

    back(router);
    expect(shown()).toBe(PRIMARY_CHAT);
    forward(router);
    expect([shown(), at(router).index]).toEqual([B, 2]);
  });

  it("pushes nothing for a restore, a reveal or an automatic open", () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    press(A);
    back(router);
    store().revealSurface(ref, B);
    store().open(ref, "diff", true);
    settle();
    expect(at(router)).toEqual({ index: 1, length: 3, tab: "chat" });
  });

  it("drops a queued switch when it stops watching", () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      store().activateSurface(ref, A);
    }
    settle();
    expect(router.history.length).toBe(2);
  });

  it("skips a closed tab on a Back into the thread after the watchers swap", () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      press(A);
      press(B);
      router.history.push(OTHER);
    }
    store().closeSurface(ref, B);
    {
      using _other = watching(router, scopedThreadKey(other));
      router.history.back(); // lands on the owner's closed b.ts entry
    }
    using _watch = watching(router);
    settle();
    expect([shown(), at(router)]).toEqual([A, { index: 2, length: 5, tab: A }]);
  });

  it("shows the entry's open tab on a Back into the thread after the watchers swap", () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      press(A);
      router.history.push(OTHER);
    }
    change({ type: "activate", tab: B }); // picked while the thread was not on screen
    {
      using _other = watching(router, OKEY);
      router.history.back();
    }
    using _watch = watching(router);
    expect([shown(), at(router)]).toEqual([A, { index: 2, length: 4, tab: A }]);
  });

  it("stops on the shown open tab after a Back from another thread skips a closed tab", () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      press(A);
      press(B);
      router.history.push(OTHER);
    }
    store().closeSurface(ref, B);
    change({ type: "activate", tab: A });
    {
      using _other = watching(router, OKEY);
      router.history.back(); // lands on the closed b.ts entry
    }
    using _watch = watching(router);
    settle();
    expect([shown(), at(router)]).toEqual([A, { index: 2, length: 5, tab: A }]);
  });

  it("stops on the shown open tab after a Forward from another thread skips a closed tab", () => {
    change({ type: "activate", tab: A });
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      press(B);
      press(C);
      router.history.go(-3);
    }
    store().closeSurface(ref, A);
    change({ type: "activate", tab: B });
    {
      using _other = watching(router, OKEY);
      router.history.forward(); // lands on the closed a.ts entry
    }
    using _watch = watching(router);
    settle();
    expect([shown(), at(router)]).toEqual([B, { index: 2, length: 4, tab: B }]);
  });

  it("stays put on a Back at the first entry", () => {
    const router = threadRouter([THREAD]);
    using _watch = watching(router);
    press(A);
    back(router);
    back(router);
    expect([shown(), at(router)]).toEqual([PRIMARY_CHAT, { index: 0, length: 2, tab: "chat" }]);
  });

  it("drops a pending skip when it stops watching", () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      press(A);
      press(B);
      store().closeSurface(ref, A);
      router.history.back(); // lands on the closed a.ts entry
    }
    settle();
    expect(at(router)).toEqual({ index: 2, length: 4, tab: A });
  });

  it("settles a landing once, so a restarted watcher keeps a later pick", () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      press(A);
      press(B);
      back(router);
      expect(shown()).toBe(A);
    }
    change({ type: "activate", tab: C });
    using _watch = watching(router);
    settle();
    expect([shown(), at(router).index]).toEqual([C, 2]);
  });

  it("keeps the shown tab after a history jump into the thread", () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      press(A);
      router.history.push(OTHER);
    }
    change({ type: "activate", tab: B });
    {
      using _other = watching(router, OKEY);
      router.history.back();
      router.history.go(-1);
      router.history.go(1);
    }
    using _watch = watching(router);
    settle();
    expect([shown(), at(router).index]).toEqual([B, 2]);
  });

  it("retags the entry on a close even when the same press leaves the thread", () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    press(A);
    store().closeSurface(ref, A);
    router.history.push(OTHER); // Open in main view closes the tab, then navigates
    settle();
    back(router);
    expect([shown(), at(router)]).toEqual([B, { index: 2, length: 4, tab: B }]);
  });

  it("retags the entry to Chat when the last tab closes, so Back then leaves the thread", () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    store().closeSurface(ref, B);
    store().closeSurface(ref, C);
    press(A);
    store().closeSurface(ref, A);
    settle();
    // The store drops the record of a thread whose layout is back to the lone Chat.
    expect([store().byThreadKey[KEY], at(router)]).toEqual([
      undefined,
      { index: 2, length: 3, tab: "chat" },
    ]);
    back(router);
    expect(router.history.location.pathname).toBe(OTHER);
  });

  it("pushes nothing for Find steps between Chat and a reply, but pushes a press", () => {
    const router = threadRouter([OTHER, THREAD]);
    using _watch = watching(router);
    const strip = publishWorkAreaView({ narrow: true, size: null });
    openThreadFind(KEY);
    change({ type: "open-reply", thread: ref, first: "m-1", reveal: "find" });
    settle();
    expect(shown()).toBe(replyTabId(ref, "m-1"));
    change({ type: "activate", tab: PRIMARY_CHAT }); // the next match is in the Chat
    strip();
    settle();
    expect(at(router)).toEqual({ index: 1, length: 2, tab: null });
    press(A);
    expect([shown(), at(router)]).toEqual([A, { index: 2, length: 3, tab: A }]);
  });

  it("skips a closed tab on a Back into the thread from a page with no work area", () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      press(A);
      press(B);
      router.history.push(ISSUES);
    }
    store().closeSurface(ref, B);
    router.history.back(); // lands on the closed b.ts entry while no watcher runs
    using _watch = watching(router);
    settle();
    expect([shown(), at(router)]).toEqual([A, { index: 2, length: 5, tab: A }]);
  });

  it("shows the entry's open tab on a Back into the thread from a page with no work area", () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      press(A);
      router.history.push(ISSUES);
    }
    change({ type: "activate", tab: B });
    router.history.back();
    using _watch = watching(router);
    expect([shown(), at(router)]).toEqual([A, { index: 2, length: 4, tab: A }]);
  });

  it("skips a closed tab on a Forward into the thread from a page with no work area", () => {
    change({ type: "activate", tab: A });
    const router = threadRouter([ISSUES, THREAD]);
    {
      using _watch = watching(router);
      press(B);
      press(C);
      router.history.go(-3);
    }
    store().closeSurface(ref, A);
    router.history.forward(); // lands on the closed a.ts entry while no watcher runs
    using _watch = watching(router);
    settle();
    expect([shown(), at(router)]).toEqual([B, { index: 2, length: 4, tab: B }]);
  });

  it("keeps the shown tab entry when its watcher restarts after a Back to another page", () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      router.history.back(); // lands on the other thread's untagged entry
    }
    router.history.push(THREAD);
    {
      using _watch = watching(router);
      press(A);
    }
    using _watch = watching(router); // the window turned wide and narrow again
    settle();
    expect([shown(), at(router)]).toEqual([A, { index: 2, length: 3, tab: A }]);
  });

  it("records no landing while the window is wide", () => {
    const router = threadRouter([OTHER, THREAD]);
    {
      using _watch = watching(router);
      press(A);
      press(B);
    }
    store().closeSurface(ref, A);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    router.history.back(); // a wide Back lands on the closed a.ts entry
    vi.unstubAllGlobals();
    using _watch = watching(router); // the window is narrow again
    settle();
    expect(at(router)).toEqual({ index: 2, length: 4, tab: A });
  });

  it("pushes nothing on a draft route", () => {
    const router = threadRouter([OTHER, "/draft/draft-1"]);
    using _watch = watching(router);
    press(A);
    expect(router.history.length).toBe(2);
  });

  it("pushes under the whiteboard build's basepath", () => {
    const router = threadRouter([`/chat${OTHER}`, `/chat${THREAD}`], "/chat");
    using _watch = watching(router);
    press(A);
    expect([router.history.location.pathname, at(router).tab]).toEqual([`/chat${THREAD}`, A]);
    back(router);
    expect([shown(), at(router).tab]).toEqual([PRIMARY_CHAT, "chat"]);
  });
});
