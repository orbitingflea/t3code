import "~/index.css";

import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { type RightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import {
  ENVIRONMENT_ID,
  type FakeDriver,
  type FakeThread,
  installFakeEnvironment,
  threadWithHistory,
} from "../../../test/fakeEnvironment";
import { act, render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));
// The file panel reads `state.files` and may read every file, as in the reading tests.
vi.mock(import("~/components/files/projectFilesQueryState"), async (original) =>
  (await import("~/components/files/fileReadingTestMocks")).mockProjectFiles(await original()),
);
vi.mock(import("~/state/filesystem"), async (original) =>
  (await import("~/components/files/fileReadingTestMocks")).mockFilesystem(await original()),
);
vi.mock(import("~/hooks/useTheme"), async (original) =>
  (await import("~/components/files/fileReadingTestMocks")).mockTheme(await original()),
);
vi.mock(import("~/components/DiffWorkerPoolProvider"), async () =>
  (await import("~/components/files/fileReadingTestMocks")).mockPanelParts.diffWorkers(),
);

import { sourceFile, sourceView, state } from "~/components/files/fileReadingTestKit";
import { FILE_LINK_REVEAL_ATTRIBUTE } from "~/components/files/fileSurfaceChrome";
import { resetState } from "~/components/files/fileReadingTestMocks";
import { asPaneId } from "./workArea.logic";
import { restoredRecord, restoreWorkArea } from "./workAreaStorage.logic";

const fileSurface = (path: string): RightPanelSurface => ({
  id: `file:${path}`,
  kind: "file",
  relativePath: path,
  revealLine: null,
  revealRequestId: 0,
});

const base = threadWithHistory("file-views", 1);
// The owner's answer cites line 40 of two files by their full paths, which open with no lookup.
const ownerThread: FakeThread = {
  ...base,
  items: base.items.map((item) =>
    item.type === "assistant_message"
      ? {
          ...item,
          text: "See [a.ts](/workspace/render/a.ts#L40) and [b.ts](/workspace/render/b.ts#L40).",
        }
      : item,
  ),
};
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);
const otherThread = threadWithHistory("file-views-other", 1);
// Every test serves the same threads, so a thread first shown in a later test still loads.
const THREADS = [ownerThread, otherThread];

type Tabs = string | readonly [string, ...string[]];
const tabsOf = (tabs: Tabs) => (typeof tabs === "string" ? [tabs] : tabs);

/** The Chat in p0 beside p1 and p2 below it, each showing its first tab. */
const chatBeside = (top: Tabs, bottom: Tabs) =>
  restoredRecord({
    isOpen: true,
    activeSurfaceId: null,
    surfaces: [...new Set([...tabsOf(top), ...tabsOf(bottom)])].map((id) =>
      fileSurface(id.slice("file:".length)),
    ),
    workArea: restoreWorkArea({
      root: {
        kind: "split",
        id: "s1",
        axis: "row",
        ratio: 0.4,
        first: { kind: "pane", id: "p0", tabs: ["chat"], active: "chat" },
        second: {
          kind: "split",
          id: "s2",
          axis: "column",
          ratio: 0.5,
          first: { kind: "pane", id: "p1", tabs: tabsOf(top), active: tabsOf(top)[0] },
          second: { kind: "pane", id: "p2", tabs: tabsOf(bottom), active: tabsOf(bottom)[0] },
        },
      },
      tabs: {
        chat: { kind: "primary-chat" },
        ...Object.fromEntries(
          [...tabsOf(top), ...tabsOf(bottom)].map((id) => [id, { kind: "surface" }]),
        ),
      },
      focused: "p0",
      seq: 3,
    })!,
  });

const paneById = (id: string) =>
  document.querySelector<HTMLElement>(`[data-work-area-pane="${id}"]`)!;
const tabIn = (pane: string, tab: string) =>
  paneById(pane).querySelector<HTMLElement>(`[data-right-panel-tab-id="${tab}"]`)!;

/** Opens the owner's thread on `record`; `others` hold other threads' records. */
async function openOwner(
  record: ReturnType<typeof chatBeside>,
  others: Readonly<Record<string, ReturnType<typeof chatBeside>>> = {},
) {
  await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
  resetState();
  state.files = {
    "a.ts": sourceFile("a.ts", "alpha", 300),
    "b.ts": sourceFile("b.ts", "beta", 300),
    "c.ts": sourceFile("c.ts", "gamma", 10),
    "d.ts": sourceFile("d.ts", "delta", 300),
    "e.ts": sourceFile("e.ts", "epsilon", 300),
    "f.ts": sourceFile("f.ts", "zeta", 300),
    "g.ts": sourceFile("g.ts", "eta", 300),
    "h.ts": sourceFile("h.ts", "theta", 300),
    "i.ts": sourceFile("i.ts", "iota", 300),
    "j.ts": sourceFile("j.ts", "kappa", 300),
    "k.ts": sourceFile("k.ts", "lambda", 300),
    "l.ts": sourceFile("l.ts", "mu", 300),
    "m.ts": sourceFile("m.ts", "nu", 300),
    "n.ts": sourceFile("n.ts", "xi", 300),
  };
  // The last test's views end with its layouts, so what they showed does not carry over.
  useRightPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: { ...others, [scopedThreadKey(owner)]: record } });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${ownerThread.id}`] }),
  );
  await router.load();
  await using stack = new AsyncDisposableStack();
  stack.defer(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("t3code.fileReading.v1:") || key.startsWith("t3code.fileReveal.v1:")) {
        localStorage.removeItem(key);
      }
    }
  });
  // AppRoot brings its own router.
  stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect
    .element(page.getByRole("textbox", { name: `Message ${ownerThread.title}` }))
    .toBeVisible();
  const moved = stack.move();
  return { router, [Symbol.asyncDispose]: () => moved.disposeAsync() };
}

const stripPane = () => document.querySelector<HTMLElement>("[data-work-area-pane]")!;
const stripTab = (tab: string) =>
  stripPane().querySelector<HTMLElement>(`[data-right-panel-tab-id="${tab}"]`)!;
// The lines the strip's code view draws with the cited-line mark.
const stripCited = () =>
  [
    ...(stripPane()
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelectorAll<HTMLElement>(`[data-line][${FILE_LINK_REVEAL_ATTRIBUTE}]`) ??
      []),
  ].map((row) => Number(row.dataset.line));
describe("a citation in the one strip", () => {
  it("still shows on the strip's one tab of the file after the strip shows another tab", async () => {
    using _environment = installFakeEnvironment(THREADS);
    // Wide: p1 shows a.ts; p2 shows a.ts too, so both views have been seen.
    await using _app = await openOwner(chatBeside("file:a.ts", ["file:a.ts", "file:b.ts"]));
    await vi.waitFor(() => {
      sourceView(paneById("p1")).expectLineInView(1, "alpha_1");
      sourceView(paneById("p2")).expectLineInView(1, "alpha_1");
    });
    // p2 turns to b.ts; its view of a.ts stays behind it.
    await userEvent.click(tabIn("p2", "file:b.ts"));
    await vi.waitFor(() => sourceView(paneById("p2")).expectLineInView(1, "beta_1"));
    await act(() =>
      useRightPanelStore.getState().updateWorkArea(owner, { type: "focus", pane: asPaneId("p1") }),
    );
    await page.viewport(940, 900);
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-work-area-pane]")).toHaveLength(1),
    );
    await vi.waitFor(() => sourceView(stripPane()).expectLineInView(1, "alpha_1"));
    // A citation of a.ts line 40 while the strip shows a.ts.
    await act(() => {
      const store = useRightPanelStore.getState();
      store.updateWorkArea(owner, { type: "focus", pane: asPaneId("p1") });
      store.openFile(owner, "a.ts", 40);
    });
    await vi.waitFor(() => sourceView(stripPane()).expectLineInView(40, "alpha_40"));
    await vi.waitFor(() => expect(stripCited()).toEqual([40]));

    // The strip shows b.ts, then a.ts again.
    await userEvent.click(stripTab("file:b.ts"));
    await vi.waitFor(() => sourceView(stripPane()).expectLineInView(1, "beta_1"));
    await userEvent.click(stripTab("file:a.ts"));
    await vi.waitFor(() => expect(stripPane().querySelector("diffs-container")).not.toBeNull());
    await vi.waitFor(() => expect(stripCited()).toEqual([40]));
  });
});
