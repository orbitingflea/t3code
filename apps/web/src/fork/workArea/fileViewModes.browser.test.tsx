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
          text: "See [doc.md](/workspace/render/doc.md#L41).",
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

const fileLink = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("a.chat-markdown-file-link")].find((link) =>
    link.getAttribute("href")?.endsWith(`/${name}:41`),
  )!;

async function openOwner(record: ReturnType<typeof chatBeside>, lead = "") {
  await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
  resetState();
  const markdown =
    lead + Array.from({ length: 150 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
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

const rendered = (id: string) => paneById(id).querySelector(".chat-markdown") !== null;
const shows = (id: string) => (rendered(id) ? "rendered" : "source");

it("a line link led by p1 leaves p2's source view of the file in source", async () => {
  using _environment = installFakeEnvironment([ownerThread]);
  await using _app = await openOwner(chatBeside(["file:doc.md"], ["file:c.ts", "file:doc.md"]));
  await vi.waitFor(() => expect(rendered("p1")).toBe(true));

  // First reveal: p1 is the only view showing doc.md, so it leads.
  await userEvent.click(fileLink("doc.md"));
  await vi.waitFor(() => sourceView(paneById("p1")).expectLineInView(41, "Paragraph 21."));

  // The user opens p2's own view of doc.md; it restores the file's last place (source, line 41).
  await userEvent.click(paneById("p2").querySelector('[data-right-panel-tab-id="file:doc.md"]')!);
  await vi.waitFor(() => expect(activeIn("p2")).toBe("file:doc.md"));
  await vi.waitFor(() => expect(shows("p2")).toBe("source"));

  // Second click of the same link: p1 is the first view showing doc.md, so it leads again.
  await userEvent.click(fileLink("doc.md"));
  await vi.waitFor(() => sourceView(paneById("p1")).expectLineInView(41, "Paragraph 21."));
  // p2 did not lead this reveal, so it keeps the view it showed.
  expect(shows("p2")).toBe("source");
});

it("a line link led by p2 leaves p1, which showed an earlier reveal, in source", async () => {
  using _environment = installFakeEnvironment([ownerThread]);
  // Line 1 links to line 41 of the same file; line 41 then holds "Paragraph 20.".
  await using _app = await openOwner(
    chatBeside(["file:doc.md"], ["file:doc.md"]),
    "See [line 41](/workspace/render/doc.md#L41).\n\n",
  );
  await vi.waitFor(() => {
    expect(rendered("p1")).toBe(true);
    expect(rendered("p2")).toBe(true);
  });

  // A link in Chat: p1 is the first view showing doc.md, so it leads.
  await userEvent.click(fileLink("doc.md"));
  await vi.waitFor(() => sourceView(paneById("p1")).expectLineInView(41, "Paragraph 20."));
  expect(rendered("p2")).toBe(true);

  // The same line's link inside p2's rendered doc.md: the click focuses p2, so p2 leads.
  const inP2 = [...paneById("p2").querySelectorAll<HTMLElement>(".chat-markdown a")];
  await userEvent.click(inP2[0]!);
  await vi.waitFor(() => sourceView(paneById("p2")).expectLineInView(41, "Paragraph 20."));
  // p1 did not lead this reveal, so it keeps the source view it showed.
  expect(shows("p1")).toBe("source");
});
