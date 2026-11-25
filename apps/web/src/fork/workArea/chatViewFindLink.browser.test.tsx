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
import { closeThreadFind, openThreadFind } from "~/components/chat/threadFindStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
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

import { sourceFile, state } from "~/components/files/fileReadingTestKit";
import { resetState } from "~/components/files/fileReadingTestMocks";
import { asPaneId, leaves, resolveLayout, secondaryChatTabId } from "./workArea.logic";
import { restoredRecord, restoreWorkArea } from "./workAreaStorage.logic";

const ownerThread = threadWithHistory("find-link-owner", 1);
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);
const base = threadWithHistory("find-link-other", 1);
// The other thread's answer cites a file by its full path, which opens with no lookup.
const otherThread: FakeThread = {
  ...base,
  items: base.items.map((item) =>
    item.type === "assistant_message"
      ? { ...item, text: "See [k.ts](/workspace/render/k.ts#L40) for it." }
      : item,
  ),
};
const other = scopeThreadRef(ENVIRONMENT_ID, otherThread.id);
const otherChat = secondaryChatTabId(other);
const THREADS = [ownerThread, otherThread];

const record = () =>
  restoredRecord({
    isOpen: false,
    activeSurfaceId: null,
    surfaces: [],
    workArea: restoreWorkArea({
      root: {
        kind: "split",
        id: "s2",
        axis: "row",
        ratio: 0.4,
        first: { kind: "pane", id: "p0", tabs: ["chat"], active: "chat" },
        second: {
          kind: "split",
          id: "s3",
          axis: "column",
          ratio: 0.5,
          first: { kind: "pane", id: "p1", tabs: [otherChat], active: otherChat },
          second: { kind: "pane", id: "p2", tabs: [otherChat], active: otherChat },
        },
      },
      tabs: {
        chat: { kind: "primary-chat" },
        [otherChat]: { kind: "secondary-chat", thread: other, placement: 1 },
      },
      focused: "p0",
      seq: 4,
    })!,
  });

const paneById = (id: string) =>
  document.querySelector<HTMLElement>(`[data-work-area-pane="${id}"]`)!;
const barIn = (id: string) => paneById(id)?.querySelector("[data-thread-find-bar]") ?? null;
const layoutNow = () =>
  resolveLayout(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, owner));

it("keeps Find in its view when a link there opens a file in another pane", async () => {
  using _environment = installFakeEnvironment(THREADS, { threadFind: true });
  await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
  resetState();
  state.files = { "k.ts": sourceFile("k.ts", "kappa", 300) };
  useRightPanelStore.setState({ byThreadKey: { [scopedThreadKey(owner)]: record() } });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1600, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${ownerThread.id}`] }),
  );
  await router.load();
  await using stack = new AsyncDisposableStack();
  stack.defer(closeThreadFind);
  // AppRoot brings its own router.
  stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect
    .element(page.getByRole("textbox", { name: `Message ${ownerThread.title}` }))
    .toBeVisible();
  await vi.waitFor(() =>
    expect(document.querySelectorAll("[data-work-area-pane]")).toHaveLength(3),
  );
  const linkIn = (id: string) =>
    [...paneById(id).querySelectorAll<HTMLElement>("a.chat-markdown-file-link")].find((link) =>
      link.getAttribute("href")?.includes("k.ts"),
    );
  await vi.waitFor(() => expect(linkIn("p2")).toBeDefined());
  await act(() => {
    useRightPanelStore.getState().updateWorkArea(owner, { type: "focus", pane: asPaneId("p2") });
    openThreadFind(scopedThreadKey(other));
  });
  await vi.waitFor(() => expect(barIn("p2")).not.toBeNull());

  await userEvent.click(linkIn("p2")!);
  const fileHolder = () =>
    leaves(layoutNow().root).find((node) => node.tabs.some((tab) => tab.endsWith("k.ts")))?.id;
  await vi.waitFor(() => expect(fileHolder()).toBeDefined());

  // The opened file's pane keeps the focus, and Find stays in the view the link was clicked in.
  await vi.waitFor(() => expect(layoutNow().focused).toBe(fileHolder()));
  expect(barIn("p1")).toBeNull();
  expect(barIn("p2")).not.toBeNull();
});
