import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

// The same mocks as ReopenClosedViewShortcut.browser.test.tsx: the shortcut with no app around it.
const state = vi.hoisted(() => ({
  keybindings: [] as ResolvedKeybindingsConfig,
  navigate: vi.fn(),
  openPreview: vi.fn(),
}));

vi.mock(import("~/components/preview/openPreviewSession"), async (original) => ({
  ...(await original()),
  openPreviewSession: state.openPreview,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.keybindings) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => ({})) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("~/state/preview"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    previewEnvironment: { ...actual.previewEnvironment, open: state.openPreview as never },
  };
});
vi.mock(import("~/connection/catalog"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      catalogValueAtom: Atom.make({
        isReady: true,
        entries: new Map([["remote", { target: { _tag: "DirectConnectionTarget" } }]]),
      }) as never,
    },
  };
});
vi.mock(import("~/state/shell"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const live = Atom.make({ status: "live" });
  return {
    ...actual,
    environmentShell: { ...actual.environmentShell, stateValueAtom: (() => live) as never },
  };
});
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ projectId: "project-1", worktreePath: null })) as never,
  readProject: (() => ({ workspaceRoot: "/work/project" })) as never,
}));

import { useClosedViewStore } from "~/closedViewStore";
import { ReopenClosedViewShortcut } from "~/components/ReopenClosedViewShortcut";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";

import { followTabHistory } from "./tabHistory";
import { userTabMove } from "./tabMoveScope";
import { PRIMARY_CHAT } from "./workArea.logic";

const ref = { environmentId: "remote", threadId: "thread-1" } as ScopedThreadRef;
const threadRef = (threadId: string) => ({ ...ref, threadId }) as ScopedThreadRef;
const snapshot = {
  threadId: ref.threadId,
  tabId: "closed-tab",
  navStatus: { _tag: "Success", url: "https://example.com", title: "Example" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-09-22T12:00:00.000Z",
} as const;

function setup() {
  vi.clearAllMocks();
  state.keybindings = DEFAULT_RESOLVED_KEYBINDINGS;
  state.navigate.mockResolvedValue(undefined);
  state.openPreview.mockReset();
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
}

function press(target: Element = document.body) {
  const event = new KeyboardEvent("keydown", {
    key: "T",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

/** The shortcut on thread-1's route of a router that records tab history. */
async function renderOnThread() {
  await page.viewport(800, 900);
  const history = createMemoryHistory({ initialEntries: ["/remote/thread-1"] });
  const root = createRootRoute({
    component: () => (
      <>
        <ReopenClosedViewShortcut />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    history,
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "$environmentId/$threadId" }),
    ]),
  });
  followTabHistory(router);
  state.navigate.mockImplementation(router.navigate);
  await using stack = new AsyncDisposableStack();
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64"));
  // The test supplies its own routes and history.
  stack.use(await render(<RouterProvider router={router} />, { router: false }));
  const environment = stack.move();
  return { history, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}

// A file tab shows beside the Chat; a tap on the Chat tab is a recorded tab move.
function showFileThenTapChat() {
  useRightPanelStore.getState().openFile(ref, "a.ts");
  userTabMove(ref, () =>
    useRightPanelStore.getState().updateWorkArea(ref, { type: "activate", tab: PRIMARY_CHAT }),
  );
}

describe("root reopen shortcut beside a narrow window's tab history", () => {
  it("still navigates to a cross-thread reopen's owner after a tab tap here during its await", async () => {
    setup();
    useClosedViewStore
      .getState()
      .remember({ kind: "browser", threadRef: threadRef("thread-2"), snapshot });
    const opened = Promise.withResolvers<ReturnType<typeof AsyncResult.success>>();
    state.openPreview.mockReturnValue(opened.promise);
    await using view = await renderOnThread();

    await act(() => {
      press();
    });
    await act(() => showFileThenTapChat());
    expect(view.history.length).toBe(2);
    await act(() => opened.resolve(AsyncResult.success({ tabId: "new-tab" })));

    expect(view.history.location.pathname).toBe("/remote/thread-2");
  });

  it("follows both queued reopens when a tab tap here comes between the two presses", async () => {
    setup();
    const store = useClosedViewStore.getState();
    store.remember({
      kind: "panel-tab",
      threadRef: threadRef("thread-3"),
      surface: { kind: "diff", id: "diff" },
    });
    store.remember({ kind: "browser", threadRef: threadRef("thread-2"), snapshot });
    const opened = Promise.withResolvers<ReturnType<typeof AsyncResult.success>>();
    state.openPreview.mockReturnValue(opened.promise);
    await using view = await renderOnThread();

    await act(() => {
      press();
    });
    await act(() => showFileThenTapChat());
    expect(view.history.length).toBe(2);
    await act(() => {
      press();
    });
    await act(() => opened.resolve(AsyncResult.success({ tabId: "new-tab" })));

    expect(useClosedViewStore.getState().entries).toEqual([]);
    expect(view.history.location.pathname).toBe("/remote/thread-3");
  });

  it("reopens a closed tab of this thread without a history entry from a tagged entry", async () => {
    setup();
    useClosedViewStore
      .getState()
      .remember({ kind: "panel-tab", threadRef: ref, surface: { kind: "diff", id: "diff" } });
    await using view = await renderOnThread();
    await act(() => showFileThenTapChat());
    expect(view.history.length).toBe(2);
    const actions: string[] = [];
    using _log = {
      [Symbol.dispose]: view.history.subscribe(({ action }) => actions.push(action.type)),
    };

    await act(() => {
      press();
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("diff");
    expect(state.navigate).toHaveBeenCalledOnce();
    expect(actions).toEqual([]);
    expect(view.history.length).toBe(2);
  });
});
