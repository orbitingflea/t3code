// Fork-only helper that wraps the shared fake environment for work area drag tests.
// It serves each test's threads, extra projects, and linked pull requests on the shell stream.
// Tests can also hold and accept side chat fork commands.
import {
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2DispatchCommandResult,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  answerRpc,
  type FakeThread,
  installFakeEnvironment,
  PROJECT_ID,
} from "../../../test/fakeEnvironment";

/**
 * A fixture thread for the drag shell with optional `projectId` and `pullRequests`.
 * It omits `providerSubagentOf` and `olderSettled`, which this helper does not serve.
 * Only the shell row uses `projectId`. The thread's own subscription uses the render project.
 */
export interface DragThread extends Omit<FakeThread, "providerSubagentOf" | "olderSettled"> {
  /** Defaults to the render project. List any other project in `options.projects`. */
  readonly projectId?: ProjectId;
  readonly pullRequests?: OrchestrationV2ThreadShell["pullRequests"];
}

type DragProject = Pick<OrchestrationProjectShell, "id" | "title"> &
  Partial<Pick<OrchestrationProjectShell, "repositoryIdentity">>;

const AT = "2026-03-17T19:12:28.000Z";
const AT_TIME = DateTime.makeUnsafe(AT);
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const projectOf = (project: DragProject): OrchestrationProjectShell => ({
  workspaceRoot: `/workspace/${project.title}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: AT,
  updatedAt: AT,
  ...project,
});

// The row the shared fixture's shell serves, with the fields drag scenarios add.
function rowOf(thread: DragThread): OrchestrationV2ThreadShell {
  const latest = thread.runs.at(-1);
  const modelSelection = thread.modelSelection ?? MODEL;
  return {
    id: thread.id,
    projectId: thread.projectId ?? PROJECT_ID,
    title: thread.title,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    activeProviderThreadId: thread.providerThreads?.[0]?.id ?? null,
    ...(thread.issues === undefined ? {} : { issues: thread.issues }),
    ...(thread.pullRequests === undefined ? {} : { pullRequests: thread.pullRequests }),
    lineage: {
      rootThreadId: thread.sideChatOf ?? thread.id,
      parentThreadId: thread.sideChatOf ?? null,
      relationshipToParent: null,
      ...(thread.sideChatOf ? { sideChat: true } : {}),
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: latest?.id ?? null,
    activeRunId: null,
    status: latest ? "completed" : "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: AT_TIME,
    hasActionableProposedPlan: false,
    itemCount: thread.items.length,
    visibleItemCount: thread.items.length,
    createdAt: AT_TIME,
    updatedAt: AT_TIME,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: AT_TIME,
    deletedAt: null,
  };
}

let rows: {
  threads: ReadonlyArray<DragThread>;
  projects: ReadonlyArray<OrchestrationProjectShell>;
} = { threads: [], projects: [] };
let sequence = 1;
// The app's shell subscription, which outlives the test that opened it.
let live: Queue.Queue<OrchestrationV2ShellStreamItem> | null = null;

const snapshot = (): ReadonlyArray<OrchestrationV2ShellStreamItem> => [
  {
    kind: "snapshot",
    snapshot: {
      schemaVersion: 1,
      snapshotSequence: sequence,
      projects: rows.projects,
      threads: rows.threads.map(rowOf),
      archivedThreads: [],
    },
  },
  { kind: "synchronized" },
];

const subscribeShell = () =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      yield* Queue.offerAll(queue, snapshot());
      live = queue;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (live === queue) live = null;
        }),
      );
      return Stream.fromQueue(queue);
    }),
  );

/**
 * Installs the fake environment and serves `threads` and `options.projects` beside the render
 * project in the shell. When the file's shell subscription is already open, this function pushes
 * a fresh snapshot that replaces the previous test's rows. Every test in a file that uses
 * `installDragEnvironment` must call it so the helper serves the file's first shell subscription.
 */
export function installDragEnvironment(
  threads: ReadonlyArray<DragThread>,
  options: Omit<NonNullable<Parameters<typeof installFakeEnvironment>[1]>, "extraProjects"> & {
    readonly projects?: ReadonlyArray<DragProject>;
  } = {},
): Disposable {
  const { projects = [], ...fixture } = options;
  const environment = installFakeEnvironment(threads, fixture);
  rows = { threads, projects: [{ id: PROJECT_ID, title: "render" }, ...projects].map(projectOf) };
  const shell = answerRpc(ORCHESTRATION_V2_WS_METHODS.subscribeShell, subscribeShell);
  if (live !== null) Effect.runSync(Queue.offerAll(live, snapshot()));
  return {
    [Symbol.dispose]: () => {
      shell[Symbol.dispose]();
      environment[Symbol.dispose]();
    },
  };
}

type SideChatFork = Extract<OrchestrationV2Command, { readonly type: "thread.fork" }>;

/**
 * Intercepts `dispatchCommand` to hold each side chat fork command until `accept()` runs, and
 * accepts all other commands. `accept()` answers the oldest held fork as a server does and adds
 * its side chat row to the shell. `pending()` reports whether a fork command is waiting.
 */
export function holdSideChatForks() {
  const held: Array<{
    readonly command: SideChatFork;
    readonly reply: Deferred.Deferred<OrchestrationV2DispatchCommandResult>;
  }> = [];
  const dispatch = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    (command: OrchestrationV2Command) =>
      Effect.suspend(() => {
        if (command.type !== "thread.fork" || !command.sideChat) {
          return Effect.succeed({ sequence: sequence + 1 });
        }
        const reply = Deferred.makeUnsafe<OrchestrationV2DispatchCommandResult>();
        held.push({ command, reply });
        return Deferred.await(reply);
      }),
  );
  return {
    pending: () => held.length > 0,
    accept: async () => {
      const next = held.shift();
      if (!next || live === null) throw new Error("No held side chat fork or shell subscription");
      const fork: DragThread = {
        id: next.command.targetThreadId,
        title: next.command.title ?? "Side chat",
        sideChatOf: next.command.sourceThreadId,
        runs: [],
        items: [],
      };
      rows = { ...rows, threads: [...rows.threads, fork] };
      sequence += 1;
      await Effect.runPromise(
        Queue.offer(live, {
          kind: "thread.updated",
          sequence,
          location: "active",
          thread: rowOf(fork),
        }).pipe(Effect.andThen(Deferred.succeed(next.reply, { sequence }))),
      );
    },
    [Symbol.dispose]: () => dispatch[Symbol.dispose](),
  };
}
