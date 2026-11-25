import { createMemoryHistory, RouterContextProvider } from "@tanstack/react-router";
import { EnvironmentId, ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { ThreadRelationshipsPanel } from "~/components/chat/ThreadRelationshipsControl";
import { getRouter } from "~/router";
import { useRightPanelStore } from "~/rightPanelStore";

import { act, render } from "../../../test/render";
import { userTabActions } from "./userTabActions";

const { read, toast } = vi.hoisted(() => ({
  read: vi.fn<(input: unknown) => Promise<unknown>>(),
  toast: vi.fn(),
}));

const childEnvironmentId = EnvironmentId.make("child-environment");
const childThreadId = ThreadId.make("child-thread");
const parentEnvironmentId = EnvironmentId.make("parent-environment");
// The panel reads only identity, lineage and delegation from the current thread.
const child = {
  id: childThreadId,
  title: "Child",
  lineage: { rootThreadId: childThreadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  delegatedFrom: {
    environmentId: parentEnvironmentId,
    threadId: ThreadId.make("parent-thread"),
    title: "Parent",
  },
} as Partial<OrchestrationV2ThreadShell> as OrchestrationV2ThreadShell;

vi.mock(import("~/state/orchestration"), async (original) => {
  const Effect = await import("effect/Effect");
  return {
    ...(await original()),
    threadTitlesRead: {
      label: "thread-titles-read",
      run: (_registry: unknown, input: unknown) =>
        Effect.promise(() => read(input) as Promise<{ readonly value: unknown }>).pipe(
          Effect.map((reply) => reply.value),
        ),
    } as never,
  };
});
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useThreadProjection: () => null,
  useThreadRelationshipShells: () => [child],
  // The parent is absent from this client's shell, as for a parent never loaded here.
  useQuietThreadShell: () => null,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({ label: "Linked" })) as never,
}));
vi.mock(import("~/components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});

const childRef = { environmentId: childEnvironmentId, threadId: childThreadId };
const childPath = `/${childEnvironmentId}/${childThreadId}`;
const parentPath = `/${parentEnvironmentId}/parent-thread`;

it.each([
  ["wide", 1400, 0],
  ["narrow", 800, 1],
])(
  "opens the remote parent after a tab open here during its read, in a %s window",
  async (_name, width, stops) => {
    await page.viewport(width, 900);
    useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
    read.mockReset();
    toast.mockReset();
    const answer = Promise.withResolvers<unknown>();
    read.mockImplementationOnce(() => answer.promise);

    const history = createMemoryHistory({ initialEntries: [childPath] });
    const router = getRouter(history);
    // With no app mounted, the router follows the history as its Transitioner would.
    using _follow = { [Symbol.dispose]: history.subscribe(() => void router.load()) };
    await router.load();
    await using screen = await render(
      <RouterContextProvider router={router}>
        <ThreadRelationshipsPanel
          environmentId={childEnvironmentId}
          threadId={childThreadId}
          showLineage
          showSideChats={false}
        />
        <button type="button" onClick={() => userTabActions().open(childRef, "diff")}>
          Open changes
        </button>
      </RouterContextProvider>,
      { router: false },
    );
    await screen.getByRole("button", { name: /Parent/ }).click();
    expect(read).toHaveBeenCalledOnce();
    await screen.getByRole("button", { name: "Open changes" }).click();
    expect(history.location.state.__TSR_index).toBe(stops);

    await act(() => answer.resolve({ value: { "parent-thread": "Parent" } }));
    await vi.waitFor(() => expect(router.latestLocation.pathname).toBe(parentPath));
    expect(toast).not.toHaveBeenCalled();
  },
);
