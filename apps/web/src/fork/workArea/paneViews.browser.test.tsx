import "~/index.css";

import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
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
import { render } from "../../../test/render";

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
import { restoredRecord, restoreWorkArea } from "./workAreaStorage.logic";

const fileSurface = (path: string): RightPanelSurface => ({
  id: `file:${path}`,
  kind: "file",
  relativePath: path,
  revealLine: null,
  revealRequestId: 0,
});

const base = threadWithHistory("file-views", 1);
// The owner's answer cites line 41 by its full path, which opens with no lookup.
const ownerThread: FakeThread = {
  ...base,
  items: base.items.map((item) =>
    item.type === "assistant_message"
      ? {
          ...item,
          text: "See [doc.md](/workspace/render/doc.md#L41) and [later](/workspace/render/doc.md#L121).",
        }
      : item,
  ),
};
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);

/** The Chat in p0 beside p1 and p2 stacked on the right. */
const chatBeside = (top: readonly [string, ...string[]], bottom: readonly [string, ...string[]]) =>
  restoredRecord({
    isOpen: true,
    activeSurfaceId: null,
    surfaces: [...new Set([...top, ...bottom])].map((id) => fileSurface(id.slice("file:".length))),
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
          first: { kind: "pane", id: "p1", tabs: top, active: top[0] },
          second: { kind: "pane", id: "p2", tabs: bottom, active: bottom[0] },
        },
      },
      tabs: {
        chat: { kind: "primary-chat" },
        ...Object.fromEntries([...top, ...bottom].map((id) => [id, { kind: "surface" }])),
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

const fileLink = (name: string, line = 41) =>
  [...document.querySelectorAll<HTMLElement>("a.chat-markdown-file-link")].find((link) =>
    link.getAttribute("href")?.endsWith(`/${name}:${line}`),
  )!;

async function openOwner(record: ReturnType<typeof chatBeside>) {
  await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
  resetState();
  const markdown = Array.from({ length: 150 }, (_, index) => `Paragraph ${index + 1}.`).join(
    "\n\n",
  );
  state.files = {
    "doc.md": {
      relativePath: "doc.md",
      contents: markdown,
      byteLength: markdown.length,
      truncated: false,
    },
    "a.ts": sourceFile("a.ts", "alpha", 300),
    "b.ts": sourceFile("b.ts", "beta", 300),
    "c.ts": sourceFile("c.ts", "gamma", 10),
  };
  // The last test's views end with its layouts, so what they showed does not carry over.
  useRightPanelStore.setState({ byThreadKey: {} });
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
  const markdownPreference = "t3code.renderMarkdown";
  const previous = localStorage.getItem(markdownPreference);
  localStorage.setItem(markdownPreference, "true");
  stack.defer(() => {
    if (previous === null) localStorage.removeItem(markdownPreference);
    else localStorage.setItem(markdownPreference, previous);
  });
  // AppRoot brings its own router.
  stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect
    .element(page.getByRole("textbox", { name: `Message ${ownerThread.title}` }))
    .toBeVisible();
  return stack.move();
}

const activeIn = (id: string) =>
  paneById(id).querySelector('[data-active-tab="true"]')?.getAttribute("data-right-panel-tab-id");

it("an edge drop restores only the source pane, even if the destination holds the same tab", async () => {
  using _environment = installFakeEnvironment([ownerThread]);
  await using _app = await openOwner(
    chatBeside(["file:a.ts", "file:b.ts"], ["file:c.ts", "file:a.ts"]),
  );
  expect(activeIn("p1")).toBe("file:a.ts");
  expect(activeIn("p2")).toBe("file:c.ts");

  const target = paneById("p2");
  const box = target.getBoundingClientRect();
  const dragged = paneById("p1").querySelector('[data-right-panel-tab-id="file:b.ts"]')!;
  await userEvent.dragAndDrop(page.elementLocator(dragged), page.elementLocator(target), {
    targetPosition: { x: box.width - 8, y: box.height / 2 },
    steps: 12,
  });

  await vi.waitFor(() =>
    expect(document.querySelectorAll("[data-work-area-pane]")).toHaveLength(4),
  );
  expect(stripOf("p3")).toEqual(["file:b.ts"]);
  expect(stripOf("p1")).toEqual(["file:a.ts"]);
  expect(activeIn("p1")).toBe("file:a.ts");
  expect(stripOf("p2")).toEqual(["file:c.ts", "file:a.ts"]);
  expect(activeIn("p2")).toBe("file:c.ts");
});

it("a Markdown line link leaves the other live view rendered", async () => {
  using _environment = installFakeEnvironment([ownerThread]);
  await using _app = await openOwner(chatBeside(["file:doc.md"], ["file:doc.md"]));
  const rendered = (id: string) => paneById(id).querySelector(".chat-markdown") !== null;
  await vi.waitFor(() => {
    expect(rendered("p1")).toBe(true);
    expect(rendered("p2")).toBe(true);
  });

  await userEvent.click(fileLink("doc.md"));

  const jumped = sourceView(paneById("p1"));
  await vi.waitFor(() => jumped.expectLineInView(41, "Paragraph 21."));
  expect(rendered("p2")).toBe(true);
});

it("keeps the other Markdown copy in source on a second line link", async () => {
  using _environment = installFakeEnvironment([ownerThread]);
  await using _app = await openOwner(chatBeside(["file:a.ts", "file:doc.md"], ["file:doc.md"]));
  const bottom = paneById("p2");
  await vi.waitFor(() => expect(bottom.querySelector(".chat-markdown")).not.toBeNull());

  await userEvent.click(fileLink("doc.md"));
  await vi.waitFor(() => sourceView(bottom).expectLineInView(41, "Paragraph 21."));

  const top = paneById("p1");
  const topCopy = top.querySelector('[data-right-panel-tab-id="file:doc.md"]')!;
  await userEvent.click(page.elementLocator(topCopy));
  await vi.waitFor(() => expect(activeIn("p1")).toBe("file:doc.md"));
  expect(bottom.querySelector(".chat-markdown")).toBeNull();
  const later = fileLink("doc.md", 121);
  expect(later, "The second line link must exist").toBeDefined();
  await userEvent.click(later);

  await vi.waitFor(() => sourceView(top).expectLineInView(121, "Paragraph 61."));
  const bottomRendered = bottom.querySelector(".chat-markdown") !== null;
  expect(bottomRendered, "The bottom copy should stay in source").toBe(false);
  sourceView(bottom).expectLineInView(41, "Paragraph 21.");
});
