import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useImperativeHandle, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import { deriveComposerSendState } from "../../components/ChatView.logic";
import { ComposerPrimaryActions } from "../../components/chat/ComposerPrimaryActions";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { useQueuedRunEdit } from "../../components/chat/useQueuedRunEdit";
import { useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";

interface RunStatus {
  readonly id: RunId;
  readonly status: string;
  readonly activeAttemptId?: string;
}

const mocks = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editQueuedRun: vi.fn<(value: unknown) => Promise<{ readonly _tag: "Success" | "Failure" }>>(),
    promoteQueuedRun: vi.fn<(value: unknown) => Promise<{ readonly _tag: "Success" }>>(),
    promoteCommand: {},
    // The projection's runs per thread, written by each test to stand in for the server.
    threadRuns: Atom.family((_key: string) =>
      Atom.make<ReadonlyArray<RunStatus> | null>(null).pipe(Atom.keepAlive),
    ),
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === mocks.promoteCommand ? mocks.promoteQueuedRun : mocks.editQueuedRun,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));

const runsKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const key = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;
  return {
    threadEnvironment: {
      snapshotAtom: () => Atom.make(null),
      editQueuedRun: {},
      promoteQueuedRun: mocks.promoteCommand,
    },
    environmentThreadDetails: {
      statusAtom: () => Atom.make("ready"),
      quietThreadAtom: (ref: ScopedThreadRef) =>
        Atom.make((get) => {
          const runs = get(mocks.threadRuns(key(ref)));
          if (runs === null) return null;
          // A Claude-like session whose running turn takes steering.
          return {
            projection: {
              thread: { id: ref.threadId, activeProviderThreadId: null },
              runs,
              messages: [],
              providerThreads: [],
              providerSessions: [
                {
                  id: "session",
                  status: "running",
                  capabilities: { turns: { supportsActiveSteering: true } },
                },
              ],
              providerTurns: runs.flatMap((run) =>
                run.activeAttemptId
                  ? [{ runAttemptId: run.activeAttemptId, status: "running" }]
                  : [],
              ),
            },
          };
        }),
    },
    environmentThreadShells: {
      threadShellAtom: () => Atom.make(null),
    },
  };
});

const ENV = EnvironmentId.make("env-1");
const THREAD_A: ScopedThreadRef = { environmentId: ENV, threadId: ThreadId.make("thread-a") };
const THREAD_B: ScopedThreadRef = { environmentId: ENV, threadId: ThreadId.make("thread-b") };
const RUN = RunId.make("run-1");

type HookResult = ReturnType<typeof useQueuedRunEdit>;

function projection(runs: ReadonlyArray<RunStatus>, messages: ReadonlyArray<unknown>) {
  return { runs, messages } as unknown as ThreadStructure;
}

function setRuns(ref: ScopedThreadRef, status: string) {
  appAtomRegistry.set(mocks.threadRuns(runsKey(ref)), [{ id: RUN, status }]);
}

function Harness(props: {
  readonly threadRef: ScopedThreadRef;
  readonly runStatus: string;
  readonly hookRef: RefObject<HookResult | null>;
  readonly messages: ReadonlyArray<unknown>;
  readonly ownsRun?: boolean;
  readonly recoveryTarget?: ScopedThreadRef;
}) {
  const result = useQueuedRunEdit({
    environmentId: ENV,
    routeThreadRef: props.threadRef,
    threadDraftTarget: props.threadRef,
    activeThreadId: props.threadRef.threadId,
    ...(props.ownsRun === undefined ? {} : { ownsEdit: () => props.ownsRun! }),
    ...(props.recoveryTarget === undefined ? {} : { recoveryTarget: () => props.recoveryTarget! }),
    serverProjection: projection([{ id: RUN, status: props.runStatus }], props.messages),
    promptRef: { current: "" },
    composerRef: { current: null },
  });
  useImperativeHandle(props.hookRef, () => result);
  const draft = useComposerThreadDraft(result.draftTarget);
  const sendState = deriveComposerSendState({
    prompt: draft.prompt,
    imageCount: draft.images.length + draft.files.length,
    existingAttachmentCount: result.editingAttachments?.length ?? 0,
    terminalContexts: draft.terminalContexts,
  });
  return result.isEditing ? (
    <ComposerPrimaryActions
      compact={false}
      canOperateThread
      pendingAction={null}
      isRunning={false}
      canInterrupt={false}
      isSendBusy={result.isSaving}
      sendDisabledReason={null}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent={sendState.hasSendableContent}
      isEditingQueuedMessage
      onSubmitMessage={() => void result.saveEdit(savedContent(draft.prompt), () => {})}
      onPreviousPendingQuestion={() => {}}
      onInterrupt={() => {}}
    />
  ) : null;
}

function view(
  threadRef: ScopedThreadRef,
  runStatus: string,
  hook: { current: HookResult | null },
  messages: ReadonlyArray<unknown> = [],
  ownsRun?: boolean,
) {
  return (
    <AppAtomRegistryProvider>
      <Harness
        threadRef={threadRef}
        runStatus={runStatus}
        hookRef={hook}
        messages={messages}
        {...(ownsRun === undefined ? {} : { ownsRun })}
      />
    </AppAtomRegistryProvider>
  );
}

function setup() {
  mocks.editQueuedRun.mockReset();
  mocks.promoteQueuedRun.mockReset();
  useAttachmentUploadStore.setState({ uploadsByImageId: {} });
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  setRuns(THREAD_A, "queued");
  setRuns(THREAD_B, "queued");
  return { hook: { current: null as HookResult | null } };
}

function requireHook(hook: { current: HookResult | null }): HookResult {
  if (hook.current === null) throw new Error("hook did not render");
  return hook.current;
}

async function beginChangedEdit(hook: { current: HookResult | null }) {
  await act(() =>
    requireHook(hook).beginEdit({
      runId: RUN,
      messageId: MessageId.make("message-1"),
      text: "original",
      attachments: [],
    }),
  );
  await act(() =>
    useComposerDraftStore.getState().setPrompt(requireHook(hook).draftTarget, "changed"),
  );
}

const savedContent = (prompt: string) => ({
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  prompt,
  images: [],
  files: [],
  terminalContexts: [],
  reviewComments: [],
  previewAnnotations: [],
  threadContexts: [],
  environmentContexts: [],
});

const promptOf = (ref: ScopedThreadRef) =>
  useComposerDraftStore.getState().getComposerDraft(ref)?.prompt ?? "";

// One queued-message edit per thread, owned by the chat view that lists its run (Chat mode views).
describe("useQueuedRunEdit across chat views", () => {
  it("hands an open edit to the view that lists its run, keeping the unsaved text", async () => {
    const { hook } = setup();
    await using screen = await render(view(THREAD_A, "queued", hook, [], true));
    await beginChangedEdit(hook);

    // Another view lists the run now, so this view's composer leaves the edit alone.
    await screen.rerender(view(THREAD_A, "queued", hook, [], false));
    expect(requireHook(hook).isEditing).toBe(false);
    expect(requireHook(hook).draftTarget).toBe(THREAD_A);
    await screen.rerender(view(THREAD_A, "queued", hook, [], true));

    expect(requireHook(hook).editingRunId).toBe(RUN);
    expect(
      useComposerDraftStore.getState().getComposerDraft(requireHook(hook).draftTarget)?.prompt,
    ).toBe("changed");
  });

  it("leaves another view's composer free while one view owns and saves the edit", async () => {
    const { hook } = setup();
    const other = { current: null as HookResult | null };
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finishSave!: (result: { readonly _tag: "Success" }) => void;
    mocks.editQueuedRun.mockImplementation(() => {
      started();
      return new Promise((resolve) => {
        finishSave = resolve;
      });
    });
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <Harness threadRef={THREAD_A} runStatus="queued" hookRef={hook} messages={[]} ownsRun />
        <Harness
          threadRef={THREAD_A}
          runStatus="queued"
          hookRef={other}
          messages={[]}
          ownsRun={false}
        />
      </AppAtomRegistryProvider>,
    );
    await beginChangedEdit(hook);
    expect(requireHook(other).isEditingElsewhere).toBe(true);

    // The other view cannot start a second edit that would throw this one's text away.
    await act(() =>
      requireHook(other).beginEdit({
        runId: RunId.make("run-2"),
        messageId: MessageId.make("message-2"),
        text: "another",
        attachments: [],
      }),
    );
    expect(requireHook(hook).editingRunId).toBe(RUN);
    expect(
      useComposerDraftStore.getState().getComposerDraft(requireHook(hook).draftTarget)?.prompt,
    ).toBe("changed");

    const saved = requireHook(hook).saveEdit(savedContent("changed"), () => {});
    await act(() => requested);
    expect(requireHook(hook).isSaving).toBe(true);
    expect(requireHook(other).isSaving).toBe(false);
    finishSave({ _tag: "Success" });
    await act(() => saved);
  });

  it("recovers a changed edit into the message box that shows it when its run starts", async () => {
    const { hook } = setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <Harness
          threadRef={THREAD_A}
          runStatus="queued"
          hookRef={hook}
          messages={[]}
          recoveryTarget={THREAD_B}
        />
      </AppAtomRegistryProvider>,
    );
    await beginChangedEdit(hook);
    await act(() => setRuns(THREAD_A, "running"));

    expect(promptOf(THREAD_B)).toBe("changed");
    expect(promptOf(THREAD_A)).toBe("");
  });
});
