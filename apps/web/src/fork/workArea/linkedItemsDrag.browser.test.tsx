import "~/index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { type Locator, page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; see ChatView.browser.test.tsx.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  answerRpc,
  ENVIRONMENT_ID,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

import { type DragThread, installDragEnvironment } from "./dragTestEnvironment";
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

// The preview browser exists in the desktop app or with a server browser; a test turns it on.
const preview = vi.hoisted(() => ({ available: false }));
vi.mock(import("~/browser/previewRuntime"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    isPreviewAvailableFor: (environmentId: EnvironmentId) =>
      preview.available || actual.isPreviewAvailableFor(environmentId),
  };
});

function previewOn(): Disposable {
  preview.available = true;
  return { [Symbol.dispose]: () => (preview.available = false) };
}

type Point = { readonly x: number; readonly y: number };

const WIDGETS = ProjectId.make("project-widgets");
const pullRequestUrl = "https://github.com/acme/widgets/pull/7";
const issueUrl = "https://linear.app/acme/issue/WID-12/fix-the-widget";
// A thread of a GitHub project with one linked pull request and one linked issue. Every test
// installs it, so the server config the file's first test caches offers issues.
const reviewedThread: DragThread = {
  ...threadWithHistory("reviewed", 1),
  projectId: WIDGETS,
  pullRequests: [
    {
      host: "github.com",
      repository: "acme/widgets",
      number: 7,
      url: pullRequestUrl,
      source: "agent",
      linkedAt: "2026-01-01T00:00:00.000Z",
      snapshot: {
        state: "open",
        title: "Add the widget",
        headBranch: "widget",
        baseBranch: "main",
        isDraft: false,
        updatedAt: null,
        syncedAt: "2026-01-01T00:00:00.000Z",
      },
      stack: null,
    },
  ],
  issues: [
    {
      projectId: WIDGETS,
      tracker: IssueTrackerKind.make("linear"),
      host: "linear.app",
      scope: "WID",
      key: "WID-12",
      url: issueUrl,
      source: "manual",
      linkedAt: "2026-01-01T00:00:00.000Z",
      displayKey: "WID-12",
      title: "Fix the widget",
    },
  ],
};
const reviewed = scopeThreadRef(ENVIRONMENT_ID, reviewedThread.id);
const withWidgets = {
  projects: [
    {
      id: WIDGETS,
      title: "widgets",
      repositoryIdentity: {
        provider: SourceControlProviderKind.make("github"),
        canonicalKey: "github.com/acme/widgets",
        displayName: "acme/widgets",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/widgets.git",
        },
      },
    },
  ],
};

// The Chat beside the Linked items tab.
const chatBesideLinkedItems = () =>
  restoredRecord({
    isOpen: true,
    activeSurfaceId: null,
    surfaces: [
      { id: "pull-requests", kind: "pull-requests" },
      { id: "diff", kind: "diff" },
    ],
    workArea: restoreWorkArea({
      root: {
        kind: "split",
        id: "s1",
        axis: "row",
        ratio: 0.5,
        first: { kind: "pane", id: "p0", tabs: ["chat"], active: "chat" },
        second: {
          kind: "pane",
          id: "p1",
          tabs: ["pull-requests", "diff"],
          active: "pull-requests",
        },
      },
      tabs: {
        chat: { kind: "primary-chat" },
        "pull-requests": { kind: "surface" },
        diff: { kind: "surface" },
      },
      focused: "p0",
      seq: 2,
    })!,
  });

const paneById = (id: string) => document.querySelector(`[data-work-area-pane="${id}"]`)!;
const tabIn = (pane: string, tab: string) =>
  paneById(pane).querySelector(`[data-right-panel-tab-id="${CSS.escape(tab)}"]`)!;
/** The tab ids of a pane's strip, in the order drawn. */
const stripOf = (pane: Element) =>
  [...pane.querySelectorAll("[data-right-panel-tab-id]")].map((tab) =>
    tab.getAttribute("data-right-panel-tab-id"),
  );

/** A Linked items row link; the Chat's header links the same pull request, so it is found in p1. */
const rowLink = (url: string) =>
  vi.waitFor(() => {
    const link = paneById("p1").querySelector<HTMLAnchorElement>(`a[href="${url}"]`);
    expect(link).not.toBeNull();
    return link!;
  });

async function openReviewed(settings: Partial<typeof DEFAULT_CLIENT_SETTINGS> = {}) {
  useRightPanelStore.setState({
    byThreadKey: { [scopedThreadKey(reviewed)]: chatBesideLinkedItems() },
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    pullRequestLinksOpenInApp: true,
    ...settings,
  });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${reviewedThread.id}`] }),
  );
  await router.load();
  await using stack = new AsyncDisposableStack();
  // AppRoot brings its own router.
  const app = stack.use(await render(<AppRoot router={router} />, { router: false }));
  await expect
    .element(page.getByRole("textbox", { name: `Message ${reviewedThread.title}` }))
    .toBeVisible();
  stack.move();
  return app;
}

// The card stays open from an earlier test in this file, where a second press would close it.
async function openThreadDetails() {
  const toggle = page.getByRole("button", { name: "Toggle thread details panel" });
  if (toggle.element().getAttribute("aria-pressed") !== "true") await userEvent.click(toggle);
}

/** A real native drag of `source` released at `at` in `target`, by default before its first tab. */
async function dragOnto(
  source: Element | Locator,
  target: Element,
  at: (box: DOMRect) => Point = (box) => ({ x: box.left + 4, y: box.top + box.height / 2 }),
) {
  const box = target.getBoundingClientRect();
  const point = at(box);
  const from = source instanceof Element ? page.elementLocator(source) : source;
  await userEvent.dragAndDrop(from, page.elementLocator(target), {
    targetPosition: { x: point.x - box.left, y: point.y - box.top },
    steps: 12,
  });
}

/** Whether `check` held at any DOM change until the returned function is called. */
function watchFor(check: () => boolean): () => boolean {
  let seen = check();
  const observer = new MutationObserver(() => {
    seen ||= check();
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true });
  return () => {
    observer.disconnect();
    return seen;
  };
}
const dragShown = () =>
  document.documentElement.hasAttribute("data-panel-link-drag") ||
  document.querySelector("[data-work-area-drop-ghost]") !== null;

async function expectDragDone() {
  await vi.waitFor(() => {
    expect(document.documentElement.hasAttribute("data-panel-link-drag")).toBe(false);
    expect(document.querySelector("[data-work-area-drop-ghost]")).toBeNull();
  });
}

describe("drag a Linked items row", () => {
  it("opens a pull request row dropped on another pane's tab strip as its tab there", async () => {
    using _environment = installDragEnvironment([reviewedThread], withWidgets);
    await using _app = await openReviewed();

    await dragOnto(await rowLink(pullRequestUrl), tabIn("p0", "chat"));

    await vi.waitFor(() =>
      expect(stripOf(paneById("p0"))).toEqual([expect.stringMatching(/^pull-request:/), "chat"]),
    );
    expect(stripOf(paneById("p1"))).toEqual(["pull-requests", "diff"]);
    await expectDragDone();
  });

  it("still adds a pull request row dropped on the composer as context, opening no tab", async () => {
    using _environment = installDragEnvironment([reviewedThread], withWidgets);
    await using _app = await openReviewed();
    const composer = page.getByTestId("composer-editor").element();
    expect(composer.textContent).not.toContain("#7");

    await dragOnto(await rowLink(pullRequestUrl), composer, (box) => ({
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
    }));

    await vi.waitFor(() => expect(composer.textContent).toContain("#7"));
    expect(stripOf(paneById("p0"))).toEqual(["chat"]);
    expect(stripOf(paneById("p1"))).toEqual(["pull-requests", "diff"]);
  });

  it("opens a pull request row whose click uses the in-app browser in the preview browser where it is dropped", async () => {
    using _environment = installDragEnvironment([reviewedThread], withWidgets);
    using _preview = previewOn();
    const urls: string[] = [];
    using _open = answerRpc(WS_METHODS.previewOpen, (input: { readonly url: string }) => {
      urls.push(input.url);
      return Effect.succeed({
        threadId: reviewed.threadId,
        tabId: "review-preview",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    });
    await using _app = await openReviewed({
      pullRequestLinksOpenInApp: false,
      browserLinkTarget: "app",
    });
    const shown = watchFor(dragShown);

    await dragOnto(await rowLink(pullRequestUrl), tabIn("p0", "chat"));

    expect(shown()).toBe(true);
    await vi.waitFor(() =>
      expect(stripOf(paneById("p0"))).toEqual(["browser:review-preview", "chat"]),
    );
    expect(urls).toEqual([pullRequestUrl]);
    expect(stripOf(paneById("p1"))).toEqual(["pull-requests", "diff"]);
    await expectDragDone();
  });

  it("opens an issue row dropped on another pane's tab strip as its issue tab there", async () => {
    using _environment = installDragEnvironment([reviewedThread], withWidgets);
    await using _app = await openReviewed();

    await dragOnto(await rowLink(issueUrl), tabIn("p0", "chat"));

    await vi.waitFor(() =>
      expect(stripOf(paneById("p0"))).toEqual([expect.stringMatching(/^issue:/), "chat"]),
    );
    expect(stripOf(paneById("p1"))).toEqual(["pull-requests", "diff"]);
    await expectDragDone();
  });
});

describe("drag a Thread details row", () => {
  it("opens the issue tab where the row is dropped", async () => {
    using _environment = installDragEnvironment([reviewedThread], withWidgets);
    await using _app = await openReviewed();
    await openThreadDetails();
    const row = await vi.waitFor(() => {
      const link = document.querySelector<HTMLAnchorElement>(
        `[data-thread-details-panel] a[href="${issueUrl}"]`,
      );
      expect(link).not.toBeNull();
      return link!;
    });
    const shown = watchFor(dragShown);

    await dragOnto(row, tabIn("p1", "diff"));

    expect(shown()).toBe(true);
    await vi.waitFor(() =>
      expect(stripOf(paneById("p1"))).toEqual([
        "pull-requests",
        expect.stringMatching(/^issue:/),
        "diff",
      ]),
    );
    expect(stripOf(paneById("p0"))).toEqual(["chat"]);
    await expectDragDone();
  });

  it("opens the pull request tab where the row is dropped", async () => {
    using _environment = installDragEnvironment([reviewedThread], withWidgets);
    await using _app = await openReviewed();
    await openThreadDetails();
    // A locator, not an element: the row redraws once the pull request's details load.
    const row = page.getByRole("button", { name: /^Pull request #7, open/ });
    await expect.element(row).toBeVisible();
    const shown = watchFor(dragShown);

    await dragOnto(row, tabIn("p1", "diff"));

    expect(shown()).toBe(true);
    await vi.waitFor(() =>
      expect(stripOf(paneById("p1"))).toEqual([
        "pull-requests",
        expect.stringMatching(/^pull-request:/),
        "diff",
      ]),
    );
    expect(stripOf(paneById("p0"))).toEqual(["chat"]);
    await expectDragDone();
  });
});
