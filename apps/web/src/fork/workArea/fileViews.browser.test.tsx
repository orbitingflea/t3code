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
import { resetState } from "~/components/files/fileReadingTestMocks";
import { asPaneId, surfaceTabId } from "./workArea.logic";
import { restoredRecord, restoreWorkArea } from "./workAreaStorage.logic";

const FILE = "file:a.ts";
// Each test reads its own file, since a file's reading place outlives the test.
const KEPT = "file:b.ts";
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
const stripOf = (id: string) =>
  [...paneById(id).querySelectorAll("[data-right-panel-tab-id]")].map((tab) =>
    tab.getAttribute("data-right-panel-tab-id"),
  );

// The source line saved for a workspace file once its save delay passed.
const savedLine = (path: string): number | undefined =>
  JSON.parse(
    localStorage.getItem(
      `t3code.fileReading.v1:${JSON.stringify([ENVIRONMENT_ID, `/workspace/render/${path}`, "source"])}`,
    ) ?? "null",
  )?.line;

const tabIn = (pane: string, tab: string) =>
  paneById(pane).querySelector<HTMLElement>(`[data-right-panel-tab-id="${tab}"]`)!;

const fileLink = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("a.chat-markdown-file-link")].find((link) =>
    link.getAttribute("href")?.endsWith(`/${name}:40`),
  )!;

function deepActiveElement() {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

async function openOwner(record: ReturnType<typeof chatBeside>) {
  await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
  resetState();
  state.files = {
    "a.ts": sourceFile("a.ts", "alpha", 300),
    "b.ts": sourceFile("b.ts", "beta", 300),
    "c.ts": sourceFile("c.ts", "gamma", 10),
    "d.ts": sourceFile("d.ts", "delta", 300),
    "e.ts": sourceFile("e.ts", "epsilon", 300),
  };
  useRightPanelStore.setState({ byThreadKey: { [scopedThreadKey(owner)]: record } });
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
  return stack.move();
}

describe("one file open in two panes", () => {
  it("reveals a clicked line in the view it jumps to and leaves the other view where it was read", async () => {
    using _environment = installFakeEnvironment([ownerThread]);
    await using _app = await openOwner(chatBeside(FILE, FILE));
    const jumped = sourceView(paneById("p1"));
    const other = sourceView(paneById("p2"));
    await vi.waitFor(() => {
      jumped.expectLineInView(1, "alpha_1");
      other.expectLineInView(1, "alpha_1");
    });
    await userEvent.wheel(other.scroller(), { delta: { y: 3000 } });
    await vi.waitFor(() => expect(other.topLine().line).toBeGreaterThan(100));
    const read = other.topLine();

    await userEvent.click(fileLink("a.ts"));

    // Both views get the reveal in one render, so the other view's would have landed with it.
    await vi.waitFor(() => jumped.expectLineInView(40, "alpha_40"));
    expect(other.topLine()).toEqual(read);
  });

  it("starts typing in the view left open at its own cited line once the other view closes", async () => {
    using _environment = installFakeEnvironment([ownerThread]);
    await using _app = await openOwner(chatBeside(KEPT, "file:c.ts"));
    const kept = sourceView(paneById("p1"));
    await vi.waitFor(() => kept.expectLineInView(1, "beta_1"));
    await userEvent.click(fileLink("b.ts"));
    await vi.waitFor(() => kept.expectLineInView(40, "beta_40"));
    // The cited line sits mid-view, below the first line in full view.
    expect(kept.topLine().line).toBeLessThan(39);
    // A second view mounts after the first, as an Alt-drag of the tab into p2 makes it.
    await act(() =>
      useRightPanelStore.getState().updateWorkArea(owner, {
        type: "place",
        source: { view: { pane: asPaneId("p1"), tab: surfaceTabId(KEPT) }, copy: true },
        at: { kind: "join", pane: asPaneId("p2") },
      }),
    );
    await vi.waitFor(() => expect(stripOf("p2")).toEqual(["file:c.ts", KEPT]));
    const closing = sourceView(paneById("p2"));
    await vi.waitFor(() => expect(closing.topLine().line).toBeGreaterThan(0));
    await userEvent.wheel(closing.scroller(), { delta: { y: 3000 } });
    await vi.waitFor(() => expect(closing.topLine().line).toBeGreaterThan(100));
    await userEvent.click(
      page.elementLocator(paneById("p2")).getByRole("button", { name: "Close b.ts" }),
    );
    await vi.waitFor(() => expect(stripOf("p2")).toEqual(["file:c.ts"]));
    expect(stripOf("p1")).toEqual([KEPT]);

    paneById("p1").querySelector<HTMLElement>("[data-file-content-focus]")!.focus();
    await vi.waitFor(() => expect(deepActiveElement()?.matches("[data-content]")).toBe(true));
    await userEvent.keyboard("Z");

    await vi.waitFor(() => expect(kept.line(40)?.textContent).toContain("Zconst beta_40 "));
  });

  it("brings each view of a file back to its own place after a switch to another tab", async () => {
    using _environment = installFakeEnvironment([ownerThread]);
    await using _app = await openOwner(chatBeside("file:d.ts", ["file:d.ts", "file:c.ts"]));
    const top = sourceView(paneById("p1"));
    const bottom = sourceView(paneById("p2"));
    await vi.waitFor(() => {
      top.expectLineInView(1, "delta_1");
      bottom.expectLineInView(1, "delta_1");
    });
    await userEvent.wheel(bottom.scroller(), { delta: { y: 3000 } });
    await vi.waitFor(() => expect(savedLine("d.ts")).toBeGreaterThan(100));
    const bottomPlace = bottom.topLine();
    // The top view reads last, so the file's place is the top view's.
    await userEvent.wheel(top.scroller(), { delta: { y: 1200 } });
    await vi.waitFor(() => expect(savedLine("d.ts")).toBeLessThan(bottomPlace.line - 20));

    await userEvent.click(tabIn("p2", "file:c.ts"));
    await vi.waitFor(() => bottom.expectLineInView(1, "gamma_1"));
    await userEvent.click(tabIn("p2", "file:d.ts"));

    await vi.waitFor(() => expect(bottom.topLine()).toEqual(bottomPlace));
  });

  it("opens a file's one view, moved away and back, where it was read last", async () => {
    using _environment = installFakeEnvironment([ownerThread]);
    await using _app = await openOwner(chatBeside(["file:e.ts", "file:c.ts"], "file:c.ts"));
    const top = sourceView(paneById("p1"));
    const bottom = sourceView(paneById("p2"));
    await vi.waitFor(() => top.expectLineInView(1, "epsilon_1"));
    await userEvent.wheel(top.scroller(), { delta: { y: 1200 } });
    await vi.waitFor(() => expect(top.topLine().line).toBeGreaterThan(20));
    const first = top.topLine();
    await vi.waitFor(() => expect(savedLine("e.ts")).toBeGreaterThan(20));
    const move = (from: string, to: string) =>
      act(() =>
        useRightPanelStore.getState().updateWorkArea(owner, {
          type: "place",
          source: { view: { pane: asPaneId(from), tab: surfaceTabId("file:e.ts") } },
          at: { kind: "join", pane: asPaneId(to) },
        }),
      );

    await move("p1", "p2");
    await vi.waitFor(() => expect(stripOf("p1")).toEqual(["file:c.ts"]));
    await vi.waitFor(() => expect(bottom.topLine()).toEqual(first));
    await userEvent.wheel(bottom.scroller(), { delta: { y: 3000 } });
    await vi.waitFor(() => expect(bottom.topLine().line).toBeGreaterThan(first.line + 20));
    const last = bottom.topLine();
    await vi.waitFor(() => expect(savedLine("e.ts")).toBeGreaterThan(first.line + 20));
    await move("p2", "p1");

    await vi.waitFor(() => expect(top.topLine()).toEqual(last));
  });
});
