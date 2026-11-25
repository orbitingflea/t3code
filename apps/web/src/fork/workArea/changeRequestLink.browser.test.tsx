import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ preview: vi.fn(), openLink: vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.preview }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => state.openLink }));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => EnvironmentId.make("local"),
}));
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  readProjects: () => [project],
  useProjects: () => [project],
  readProject: () => project,
  readThreadShell: () => ({ projectId: "project", worktreePath: null }),
}));
vi.mock("~/state/server", async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original<typeof import("~/state/server")>()),
    environmentServerConfigsAtom: Atom.make(new Map([["local", {}]])),
  };
});

import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { useDiffPanelStore } from "~/diffPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import { hostShownChat } from "./chatFileOpener";
import { holders, PRIMARY_CHAT, resolveLayout, surfaceTabId, type TabId } from "./workArea.logic";
import { publishWorkAreaView, runWithOpenOrigin } from "./workAreaView";

const environmentId = EnvironmentId.make("local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const secondary = scopeThreadRef(environmentId, ThreadId.make("secondary"));
const project = {
  id: "project",
  environmentId,
  workspaceRoot: "/repo",
  repositoryIdentity: {
    provider: "github",
    canonicalKey: "github.com/effect-ts/effect",
    displayName: "Effect-TS/effect",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/Effect-TS/effect.git",
    },
  },
};
const sha = "a".repeat(40);
const commitUrl = `https://github.com/Effect-TS/effect/commit/${sha}`;
const pullRequestCommitUrl = `https://github.com/Effect-TS/effect/pull/1/commits/${sha}`;

function CommitLink(props: { thread: typeof threadRef; url: string; opened: boolean[] }) {
  const open = useOpenChangeRequestLink(props.thread);
  return (
    <a
      href={props.url}
      onClick={(event) => {
        event.preventDefault();
        props.opened.push(
          runWithOpenOrigin({ record: threadRef, tab: PRIMARY_CHAT }, () => open(event, props.url)),
        );
      }}
    >
      Commit
    </a>
  );
}

function setup() {
  state.preview
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ sources: [{ kind: "commit", headRef: sha }] }));
  state.openLink.mockReset().mockResolvedValue(undefined);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    pullRequestLinksOpenInApp: true,
    browserLinkTarget: "system",
  });
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
}

const recordOf = (thread: typeof threadRef) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, thread);
const layout = () => resolveLayout(recordOf(threadRef));
const holderOf = (tab: TabId) => holders(layout().root, tab)[0];

it("opens a commit from the Chat in the Diff tab beside the Chat after the lookup", async () => {
  setup();
  using _view = {
    [Symbol.dispose]: publishWorkAreaView({ narrow: false, size: { width: 1500, height: 800 } }),
  };
  const store = useRightPanelStore.getState();
  // [a.ts | Chat | b.ts] with a.ts focused: a sourceless open would land in the focused pane.
  store.openFile(threadRef, "a.ts");
  store.openFile(threadRef, "b.ts");
  store.updateWorkArea(threadRef, {
    type: "place",
    source: {
      view: { pane: holderOf(surfaceTabId("file:a.ts"))!.id, tab: surfaceTabId("file:a.ts") },
    },
    at: { kind: "edge", pane: holderOf(PRIMARY_CHAT)!.id, edge: "left" },
  });
  store.updateWorkArea(threadRef, {
    type: "focus",
    pane: holderOf(surfaceTabId("file:a.ts"))!.id,
  });
  await using screen = await render(
    <AppAtomRegistryProvider>
      <CommitLink thread={threadRef} url={commitUrl} opened={[]} />
    </AppAtomRegistryProvider>,
  );
  await screen.getByRole("link", { name: "Commit" }).click();
  await vi.waitFor(() => expect(holderOf(surfaceTabId("diff"))?.tabs).toContain("file:b.ts"));
  expect(useDiffPanelStore.getState().byThreadKey).toEqual({
    [scopedThreadKey(threadRef)]: { kind: "commit", sha, baseRef: null },
  });
});

it.each<[string, string, boolean, readonly string[]]>([
  ["follows a plain commit link as a link", commitUrl, false, []],
  ["opens a pull request's commit link as the pull request", pullRequestCommitUrl, true, ["#1"]],
])(
  "in a secondary Chat, %s instead of opening the owner's Diff tab",
  async (_name, url, handled, pullRequests) => {
    setup();
    using _hosted = { [Symbol.dispose]: hostShownChat(secondary, threadRef)! };
    const opened: boolean[] = [];
    await using screen = await render(
      <AppAtomRegistryProvider>
        <CommitLink thread={secondary} url={url} opened={opened} />
      </AppAtomRegistryProvider>,
    );
    await screen.getByRole("link", { name: "Commit" }).click();
    expect(opened).toEqual([handled]);
    expect(state.preview).not.toHaveBeenCalled();
    expect(useDiffPanelStore.getState().byThreadKey).toEqual({});
    expect(
      recordOf(threadRef).surfaces.map((surface) =>
        surface.kind === "pull-request" ? `#${surface.number}` : surface.kind,
      ),
    ).toEqual(pullRequests);
    expect(recordOf(secondary).surfaces).toEqual([]);
  },
);
