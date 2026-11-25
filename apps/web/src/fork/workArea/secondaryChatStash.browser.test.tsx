import "~/index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useComposerDraftStore } from "~/composerDraftStore";
import { usePromptStashStore, writePromptStashStorageForTest } from "~/promptStashStore";
import { type ThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { render } from "../../../test/render";
import {
  ENVIRONMENT_ID,
  type FakeDriver,
  type FakeThread,
  installFakeEnvironment,
  threadWithHistory,
} from "../../../test/fakeEnvironment";
import { secondaryChatTabId } from "./workArea.logic";
import { restoredRecord, restoreWorkArea } from "./workAreaStorage.logic";

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

const ownerThread = threadWithHistory("owner", 1);
const otherThread = threadWithHistory("other", 1);
const owner = scopeThreadRef(ENVIRONMENT_ID, ownerThread.id);

const other = scopeThreadRef(ENVIRONMENT_ID, otherThread.id);

function setup(record?: ThreadRightPanelState) {
  useRightPanelStore.setState({
    byThreadKey: record ? { [scopedThreadKey(owner)]: record } : {},
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
}

async function openOwner(thread: FakeThread = ownerThread) {
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using stack = new AsyncDisposableStack();
  // AppRoot brings its own router.
  const app = stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect
    .element(page.getByRole("textbox", { name: `Message ${thread.title}` }))
    .toBeVisible();
  stack.move();
  return Object.assign(app, { router });
}

const otherChat = secondaryChatTabId(other);

it("stashes only the draft in the pane where Mod+S was pressed", async () => {
  const thirdThread = threadWithHistory("third", 1);
  const third = scopeThreadRef(ENVIRONMENT_ID, thirdThread.id);
  const thirdChat = secondaryChatTabId(third);
  using _environment = installFakeEnvironment([ownerThread, otherThread, thirdThread]);
  using _cleanup = {
    [Symbol.dispose]: () => {
      writePromptStashStorageForTest("");
      useComposerDraftStore.getState().clearComposerContent(other);
      useComposerDraftStore.getState().clearComposerContent(third);
    },
  };
  writePromptStashStorageForTest("");
  setup(
    restoredRecord({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
      workArea: restoreWorkArea({
        root: {
          kind: "split",
          id: "s1",
          axis: "row",
          ratio: 1 / 3,
          first: { kind: "pane", id: "p0", tabs: ["chat"], active: "chat" },
          second: {
            kind: "split",
            id: "s2",
            axis: "row",
            ratio: 0.5,
            first: { kind: "pane", id: "p1", tabs: [otherChat], active: otherChat },
            second: { kind: "pane", id: "p2", tabs: [thirdChat], active: thirdChat },
          },
        },
        tabs: {
          chat: { kind: "primary-chat" },
          [otherChat]: { kind: "secondary-chat", thread: other, placement: 1 },
          [thirdChat]: { kind: "secondary-chat", thread: third, placement: 2 },
        },
        focused: "p0",
        seq: 3,
      })!,
    }),
  );
  await using _app = await openOwner();
  const left = page.getByRole("textbox", { name: `Message ${otherThread.title}` });
  const right = page.getByRole("textbox", { name: `Message ${thirdThread.title}` });
  await expect.element(left).toBeVisible();
  await expect.element(right).toBeVisible();
  await userEvent.click(left);
  await userEvent.keyboard("left pane draft");
  await userEvent.click(right);
  await userEvent.keyboard("right pane draft");
  const draft = (target: typeof other) =>
    useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
  expect([draft(other), draft(third)]).toEqual(["left pane draft", "right pane draft"]);

  await userEvent.click(left);
  await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");
  await vi.waitFor(() => expect(usePromptStashStore.getState().entries).toHaveLength(1));
  expect({
    stashed: usePromptStashStore.getState().entries[0]?.prompt,
    left: draft(other),
    right: draft(third),
  }).toEqual({ stashed: "left pane draft", left: "", right: "right pane draft" });
});
