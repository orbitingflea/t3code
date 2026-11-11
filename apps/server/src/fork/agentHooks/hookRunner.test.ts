import { describe, expect, it } from "vite-plus/test";

import recorded from "./fixtures/recordedPayloads.json" with { type: "json" };
import {
  handleHookCall,
  type HookExit,
  interpretHookExit,
  loadConfig,
  MAX_CONTEXT_CHARS,
  mergeResults,
} from "./hookRunner.ts";
import { type Agent, isoTime, runnerPaths, type ToolClass, type UnifiedEvent } from "./shapes.ts";

const NodeChildProcess = process.getBuiltinModule("node:child_process");
const NodeFS = process.getBuiltinModule("node:fs");
const NodeOS = process.getBuiltinModule("node:os");
const NodePath = process.getBuiltinModule("node:path");

interface Stub {
  readonly events: ReadonlyArray<UnifiedEvent>;
  readonly tools?: ReadonlyArray<ToolClass>;
  readonly exit?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly command?: ReadonlyArray<string>;
  readonly timeout?: number;
}

// Stubs of calls that run at the same time share a capture file, so each adds its line in one write.
const STUB_SCRIPT =
  'line="$1.$$"; { cat; echo; } > "$line"; cat "$line" >> "$1"; rm "$line"; printf %s "$2"; printf %s "$3" >&2; exit "$4"';

const context = (text: string): string => JSON.stringify({ context: text });

const makeSandbox = (stubs: ReadonlyArray<Stub>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-hooks-test-"));
  const hooksDir = NodePath.join(root, "hooks");
  NodeFS.mkdirSync(hooksDir);
  const captureFile = (index: number) => NodePath.join(root, `captured-${index}.jsonl`);
  const hooks = Object.fromEntries(
    stubs.map((stub, index) => [
      `stub${index}`,
      {
        events: stub.events,
        ...(stub.tools === undefined ? {} : { tools: stub.tools }),
        ...(stub.timeout === undefined ? {} : { timeout: stub.timeout }),
        command: stub.command ?? [
          "/bin/sh",
          "-c",
          STUB_SCRIPT,
          "stub",
          captureFile(index),
          stub.stdout ?? "",
          stub.stderr ?? "",
          String(stub.exit ?? 0),
        ],
      },
    ]),
  );
  NodeFS.writeFileSync(
    NodePath.join(hooksDir, "hooks.json"),
    JSON.stringify({ version: 1, hooks }),
  );
  const env = {
    HOME: root,
    AGENT_HOOKS_DIR: hooksDir,
    XDG_STATE_HOME: NodePath.join(root, "state"),
  };
  const readLines = (file: string): ReadonlyArray<Record<string, unknown>> =>
    NodeFS.existsSync(file)
      ? NodeFS.readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line))
      : [];
  return {
    root,
    env,
    call: (agent: Agent, nativeEvent: string, payload: unknown) =>
      handleHookCall(agent, nativeEvent, JSON.stringify(payload), env),
    payloads: (index = 0) => readLines(captureFile(index)),
    errors: () => readLines(NodePath.join(root, "state", "agent-hooks", "errors.jsonl")),
  };
};

const ALL_EVENTS: ReadonlyArray<UnifiedEvent> = [
  "SessionStart",
  "PromptSubmit",
  "PreTool",
  "PostTool",
  "Stop",
  "PostCompact",
];

const claudeLikeCases = (agent: "claude" | "codex") => {
  const payloads = recorded[agent];
  const editTool = agent === "claude" ? "Write" : "apply_patch";
  return [
    {
      name: `${agent}: SessionStart context reaches a new session`,
      nativeEvent: "SessionStart",
      payload: payloads.sessionStart,
      stubs: [{ events: ["SessionStart"], stdout: context("house rules") }],
      stdout:
        '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"house rules"}}',
      received: {
        event: "SessionStart",
        hook_event_name: "SessionStart",
        source: "startup",
        agent,
      },
    },
    {
      name: `${agent}: a compaction fires PostCompact and not SessionStart`,
      nativeEvent: "SessionStart",
      payload: payloads.sessionStartAfterCompaction,
      stubs: [
        { events: ["PostCompact"], stdout: context("rules again") },
        { events: ["SessionStart"], stdout: context("must not run") },
      ],
      stdout:
        '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"rules again"}}',
      received: { event: "PostCompact", hook_event_name: "SessionStart", source: "compact" },
    },
    {
      name: `${agent}: a resumed session fires nothing`,
      nativeEvent: "SessionStart",
      payload: { ...payloads.sessionStart, source: "resume" },
      stubs: [{ events: ALL_EVENTS, stdout: context("must not run") }],
      stdout: "",
      received: null,
    },
    {
      name: `${agent}: PromptSubmit context`,
      nativeEvent: "UserPromptSubmit",
      payload: payloads.userPromptSubmit,
      stubs: [{ events: ["PromptSubmit"], stdout: context("today is Monday") }],
      stdout:
        '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"today is Monday"}}',
      received: { event: "PromptSubmit", prompt: payloads.userPromptSubmit.prompt },
    },
    {
      name: `${agent}: a refused prompt drops the context of other hooks`,
      nativeEvent: "UserPromptSubmit",
      payload: payloads.userPromptSubmit,
      stubs: [
        { events: ["PromptSubmit"], stdout: context("today is Monday") },
        { events: ["PromptSubmit"], exit: 2, stderr: "no secrets in prompts" },
      ],
      stdout: '{"decision":"block","reason":"no secrets in prompts"}',
      received: { event: "PromptSubmit" },
    },
    {
      name: `${agent}: PreTool deny for a shell call`,
      nativeEvent: "PreToolUse",
      payload: payloads.preToolUseShell,
      stubs: [{ events: ["PreTool"], tools: ["shell"], exit: 2, stderr: "refused" }],
      stdout:
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"refused"}}',
      received: {
        event: "PreTool",
        hook_event_name: "PreToolUse",
        tool_class: "shell",
        tool_name: "Bash",
        file_paths: [],
      },
    },
    {
      name: `${agent}: a shell hook does not run for a file edit`,
      nativeEvent: "PreToolUse",
      payload: payloads.preToolUseEdit,
      stubs: [{ events: ["PreTool"], tools: ["shell"], exit: 2, stderr: "refused" }],
      stdout: "",
      received: null,
    },
    {
      name: `${agent}: PostTool gets no tool result, and its feedback is sent as context also when the hook blocks`,
      nativeEvent: "PostToolUse",
      payload: payloads.postToolUseEdit,
      stubs: [{ events: ["PostTool"], tools: ["edit"], exit: 2, stderr: "file too long" }],
      stdout:
        '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"file too long"}}',
      received: {
        event: "PostTool",
        tool_class: "edit",
        tool_name: editTool,
        file_paths: ["/work/project/notes.txt"],
        native: { tool_response: payloads.postToolUseEdit.tool_response },
      },
    },
    {
      name: `${agent}: Stop block makes the agent go on`,
      nativeEvent: "Stop",
      payload: payloads.stop,
      stubs: [{ events: ["Stop"], stdout: '{"decision":"block","reason":"reply is too long"}' }],
      stdout: '{"decision":"block","reason":"reply is too long"}',
      received: {
        event: "Stop",
        stop_hook_active: false,
        last_assistant_message: payloads.stop.last_assistant_message,
      },
    },
    {
      name: `${agent}: a hook without a decision prints nothing`,
      nativeEvent: "Stop",
      payload: payloads.stopAfterContinue,
      stubs: [{ events: ["Stop"] }],
      stdout: "",
      received: { event: "Stop", stop_hook_active: true },
    },
  ] as const;
};

describe("Claude and Codex translation", () => {
  it.each([...claudeLikeCases("claude"), ...claudeLikeCases("codex")])(
    "$name",
    async ({ name, nativeEvent, payload, stubs, stdout, received }) => {
      const sandbox = makeSandbox(stubs);
      const agent: Agent = name.startsWith("claude") ? "claude" : "codex";

      expect(await sandbox.call(agent, nativeEvent, payload)).toBe(stdout);

      const [got] = sandbox.payloads();
      if (received === null) {
        expect(got).toBeUndefined();
      } else {
        const { tool_response: _toolResult, ...passedThrough }: Record<string, unknown> = payload;
        expect(got).toMatchObject({ ...received, ...passedThrough, agent });
        expect(got?.native).toEqual(payload);
        expect(got).not.toHaveProperty("tool_response");
      }
      expect(sandbox.errors()).toEqual([]);
    },
  );
});

interface TranscriptStep {
  readonly type: string;
  readonly source?: string;
  readonly content?: string;
  readonly toolCalls?: ReadonlyArray<string>;
}

const makeAgyConversation = (stubs: ReadonlyArray<Stub>) => {
  const sandbox = makeSandbox(stubs);
  const transcriptPath = NodePath.join(sandbox.root, "transcript_full.jsonl");
  NodeFS.writeFileSync(transcriptPath, "");
  let nextStep = 0;
  return {
    ...sandbox,
    append: (...steps: ReadonlyArray<TranscriptStep>) => {
      for (const step of steps) {
        const line = {
          step_index: nextStep,
          source: step.source ?? (step.type === "USER_INPUT" ? "USER_EXPLICIT" : "MODEL"),
          type: step.type,
          status: "DONE",
          content: step.content ?? "",
          ...(step.toolCalls === undefined
            ? {}
            : { tool_calls: step.toolCalls.map((toolName) => ({ name: toolName, args: {} })) }),
        };
        NodeFS.appendFileSync(transcriptPath, `${JSON.stringify(line)}\n`);
        nextStep += 1;
      }
    },
    fire: (nativeEvent: string, payload: Record<string, unknown>) =>
      sandbox.call("agy", nativeEvent, { ...payload, transcriptPath }),
  };
};

const userInput = (text: string): TranscriptStep => ({
  type: "USER_INPUT",
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
});
const modelCallsTool: TranscriptStep = { type: "PLANNER_RESPONSE", toolCalls: ["write_file"] };
const toolResult: TranscriptStep = { type: "GENERIC", content: "Created file." };
const reply = (text: string): TranscriptStep => ({ type: "PLANNER_RESPONSE", content: text });
const stopHookContinued: TranscriptStep = {
  type: "SYSTEM_MESSAGE",
  source: "SYSTEM",
  content: "<SYSTEM_MESSAGE>\nStop hook blocked termination: reply is too long\n</SYSTEM_MESSAGE>",
};
const checkpoint: TranscriptStep = {
  type: "CHECKPOINT",
  source: "SYSTEM",
  content: "# Resuming from a compaction",
};

const injected = (...texts: ReadonlyArray<string>): string =>
  JSON.stringify({
    injectSteps: texts.map((text) => ({ systemMessage: { systemMessage: text } })),
  });

describe("agy translation and state", () => {
  const agy = recorded.agy;

  it("fires SessionStart once and PromptSubmit once per prompt", async () => {
    const conversation = makeAgyConversation([
      { events: ["SessionStart"], stdout: context("house rules") },
      { events: ["PromptSubmit"], stdout: context("today is Monday") },
    ]);
    conversation.append(userInput("first prompt"));

    expect(await conversation.fire("SessionStart", agy.sessionStart)).toBe(injected("house rules"));
    expect(await conversation.fire("PreInvocation", agy.preInvocation)).toBe(
      injected("today is Monday"),
    );
    conversation.append(modelCallsTool, toolResult);
    expect(await conversation.fire("PreInvocation", agy.preInvocationSecondCall)).toBe("{}");
    conversation.append(reply("done"), stopHookContinued);
    expect(await conversation.fire("PreInvocation", agy.preInvocationSecondCall)).toBe("{}");
    conversation.append(reply("done, shorter"), userInput("second prompt"));
    expect(await conversation.fire("PreInvocation", agy.preInvocation)).toBe(
      injected("today is Monday"),
    );

    expect(conversation.payloads(0)).toMatchObject([
      { event: "SessionStart", hook_event_name: "SessionStart", source: "startup", agent: "agy" },
    ]);
    expect(conversation.payloads(1)).toMatchObject([
      {
        event: "PromptSubmit",
        hook_event_name: "UserPromptSubmit",
        prompt: agy.preInvocation.lastUserInput,
        session_id: agy.preInvocation.conversationId,
        cwd: "/work/project",
        conversationId: agy.preInvocation.conversationId,
      },
      { event: "PromptSubmit" },
    ]);
  });

  it("fires PostCompact once per compaction, before the prompt that follows it", async () => {
    const conversation = makeAgyConversation([
      { events: ["PostCompact"], stdout: context("rules again") },
      { events: ["PromptSubmit"], stdout: context("today is Monday") },
    ]);
    conversation.append(userInput("first prompt"));
    await conversation.fire("PreInvocation", agy.preInvocation);
    conversation.append(reply("ok"), userInput("/compact"));

    expect(await conversation.fire("PreInvocation", agy.preInvocationCompactCommand)).toBe("{}");
    expect(await conversation.fire("Stop", agy.stopAfterCompactCommand)).toBe("{}");
    conversation.append(checkpoint, userInput("next prompt"));
    expect(await conversation.fire("PreInvocation", agy.preInvocationAfterCompaction)).toBe(
      injected("rules again", "today is Monday"),
    );
    conversation.append(modelCallsTool, toolResult);
    expect(await conversation.fire("PreInvocation", agy.preInvocationSecondCall)).toBe("{}");

    expect(conversation.payloads(0)).toMatchObject([
      { event: "PostCompact", hook_event_name: "SessionStart", source: "compact" },
    ]);
    expect(conversation.payloads(1)).toHaveLength(2);
  });

  it("runs the hooks of both events of one call at the same time", async () => {
    const pipes = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-hooks-pipes-"));
    const toCompact = NodePath.join(pipes, "compact");
    const toPrompt = NodePath.join(pipes, "prompt");
    NodeChildProcess.execFileSync("mkfifo", [toCompact, toPrompt]);
    // Each hook waits for a word from the other, so both end only when they run together.
    const meets = (script: string) => ({
      command: [
        "/bin/sh",
        "-c",
        `${script} && printf %s "$3"`,
        "meet",
        toCompact,
        toPrompt,
        context("met"),
      ],
      timeout: 3,
    });
    const conversation = makeAgyConversation([
      { events: ["PostCompact"], ...meets('echo go > "$2" && read word < "$1"') },
      { events: ["PromptSubmit"], ...meets('read word < "$2" && echo go > "$1"') },
    ]);
    await conversation.fire("PreInvocation", agy.preInvocationSecondCall);
    conversation.append(checkpoint, userInput("next prompt"));

    expect(await conversation.fire("PreInvocation", agy.preInvocationAfterCompaction)).toBe(
      injected("met", "met"),
    );
    expect(conversation.errors()).toEqual([]);
  });

  it("fires only the present prompt for a conversation older than the install", async () => {
    const conversation = makeAgyConversation([
      { events: ["PostCompact", "PromptSubmit"], stdout: context("text") },
    ]);
    conversation.append(userInput("old prompt"), checkpoint, reply("old"), userInput("new prompt"));

    expect(await conversation.fire("PreInvocation", agy.preInvocation)).toBe(injected("text"));

    expect(conversation.payloads()).toMatchObject([{ event: "PromptSubmit" }]);
  });

  it("refuses a prompt by ending the turn with a message for the user", async () => {
    const conversation = makeAgyConversation([
      { events: ["PromptSubmit"], exit: 2, stderr: "no secrets in prompts" },
    ]);
    conversation.append(userInput("first prompt"));

    expect(await conversation.fire("PreInvocation", agy.preInvocation)).toBe(
      '{"injectSteps":[{"errorMessage":{"userMessage":"no secrets in prompts"}}],"terminationBehavior":"terminate"}',
    );
  });

  it("denies a tool call with the reason and otherwise leaves the call to agy", async () => {
    const conversation = makeAgyConversation([
      { events: ["PreTool"], tools: ["shell"], exit: 2, stderr: "refused" },
    ]);

    expect(await conversation.fire("PreToolUse", agy.preToolUseShell)).toBe(
      '{"decision":"deny","reason":"refused"}',
    );
    expect(await conversation.fire("PreToolUse", agy.preToolUseEdit)).toBe('{"decision":"allow"}');

    expect(conversation.payloads()).toMatchObject([
      {
        event: "PreTool",
        hook_event_name: "PreToolUse",
        tool_class: "shell",
        tool_name: "Bash",
        tool_input: { command: "echo forbidden-probe", CommandLine: "echo forbidden-probe" },
        tool_use_id: agy.preToolUseShell.toolCall.id,
        file_paths: [],
      },
    ]);
  });

  it("delivers PostTool feedback once, at the next hook before the model is called", async () => {
    const conversation = makeAgyConversation([
      { events: ["PostTool"], tools: ["edit"], stdout: context("file too long") },
    ]);
    const secondCall = {
      ...agy.postToolUseEdit,
      stepIdx: agy.postToolUseEdit.stepIdx + 1,
      toolCall: { ...agy.postToolUseEdit.toolCall, id: "call_second" },
    };

    expect(
      await Promise.all([
        conversation.fire("PostToolUse", agy.postToolUseEdit),
        conversation.fire("PostToolUse", secondCall),
        conversation.fire("PostToolUse", { ...agy.postToolUseEdit, error: "exit status 1" }),
      ]),
    ).toEqual(["{}", "{}", "{}"]);
    expect(await conversation.fire("PostInvocation", agy.postInvocation)).toBe(
      injected("file too long", "file too long"),
    );
    expect(await conversation.fire("PostInvocation", agy.postInvocation)).toBe("{}");

    await conversation.fire("PostToolUse", agy.postToolUseEdit);
    conversation.append(userInput("prompt"));
    expect(await conversation.fire("PreInvocation", agy.preInvocation)).toBe(
      injected("file too long"),
    );

    expect(conversation.payloads()).toHaveLength(3);
    expect(conversation.payloads()[0]).toMatchObject({
      event: "PostTool",
      tool_class: "edit",
      tool_name: "write_file",
      tool_input: { file_path: "/work/project/notes.txt", Path: "/work/project/notes.txt" },
      file_paths: ["/work/project/notes.txt"],
      native: { hookEventName: "PostToolUse", toolCall: { name: "write_file" } },
    });
    expect(conversation.payloads()[0]).not.toHaveProperty("tool_response");
  });

  it("gives Stop the last reply and whether a Stop hook already continued the turn", async () => {
    const conversation = makeAgyConversation([
      { events: ["Stop"], stdout: '{"decision":"block","reason":"reply is too long"}' },
    ]);
    conversation.append(userInput("prompt"), reply("a long reply"));

    expect(await conversation.fire("Stop", agy.stop)).toBe(
      '{"decision":"continue","reason":"reply is too long"}',
    );
    conversation.append(stopHookContinued, modelCallsTool, toolResult, reply("a short reply"));
    await conversation.fire("Stop", agy.stopAfterContinue);

    expect(conversation.payloads()).toMatchObject([
      { event: "Stop", last_assistant_message: "a long reply", stop_hook_active: false },
      { event: "Stop", last_assistant_message: "a short reply", stop_hook_active: true },
    ]);
  });
});

describe("the common decision", () => {
  const exit = (fields: Partial<HookExit>): HookExit => ({
    code: 0,
    stdout: "",
    stderr: "",
    problem: null,
    ...fields,
  });
  const result = (blockReason: string | null, context: string | null) => ({
    hook: "h",
    blockReason,
    context,
    failure: null,
  });
  const failure = (text: string) => ({
    hook: "h",
    blockReason: null,
    context: null,
    failure: text,
  });

  it.each<{
    name: string;
    event: UnifiedEvent;
    exit: HookExit;
    expected: ReturnType<typeof interpretHookExit>;
  }>([
    {
      name: "no output is no decision",
      event: "PreTool",
      exit: exit({}),
      expected: result(null, null),
    },
    {
      name: "exit 2 blocks with stderr",
      event: "PreTool",
      exit: exit({ code: 2, stderr: "refused\n" }),
      expected: result("refused", null),
    },
    {
      name: "the block JSON",
      event: "Stop",
      exit: exit({ stdout: '{"decision":"block","reason":"go on"}' }),
      expected: result("go on", null),
    },
    {
      name: "Claude's permissionDecision deny",
      event: "PreTool",
      exit: exit({
        stdout:
          '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"refused"}}',
      }),
      expected: result("refused", null),
    },
    {
      name: "the context JSON",
      event: "SessionStart",
      exit: exit({ stdout: '{"context":"rules"}' }),
      expected: result(null, "rules"),
    },
    {
      name: "Claude's additionalContext",
      event: "PromptSubmit",
      exit: exit({
        stdout:
          '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"rules"}}',
      }),
      expected: result(null, "rules"),
    },
    {
      name: "a PostTool block is feedback",
      event: "PostTool",
      exit: exit({ stdout: '{"decision":"block","reason":"file too long"}' }),
      expected: result(null, "file too long"),
    },
    {
      name: "an allow answer is no decision",
      event: "PreTool",
      exit: exit({ stdout: '{"hookSpecificOutput":{"permissionDecision":"allow"}}' }),
      expected: result(null, null),
    },
    {
      name: "exit 2 with empty stderr fails",
      event: "PreTool",
      exit: exit({ code: 2 }),
      expected: failure("exit code 2 with nothing on stderr"),
    },
    {
      name: "another exit code fails",
      event: "PreTool",
      exit: exit({ code: 1, stderr: "Traceback" }),
      expected: failure("exit code 1: Traceback"),
    },
    {
      name: "text that is not JSON fails",
      event: "SessionStart",
      exit: exit({ stdout: "rules" }),
      expected: failure("stdout is not JSON: rules"),
    },
    {
      name: "a block without a reason fails",
      event: "Stop",
      exit: exit({ stdout: '{"decision":"block"}' }),
      expected: failure("a block without a reason"),
    },
    {
      name: "SessionStart cannot block",
      event: "SessionStart",
      exit: exit({ code: 2, stderr: "no" }),
      expected: failure("SessionStart cannot block"),
    },
    {
      name: "PreTool cannot add context",
      event: "PreTool",
      exit: exit({ stdout: '{"context":"note"}' }),
      expected: failure("PreTool cannot add context"),
    },
    {
      name: "a hook that did not finish fails",
      event: "Stop",
      exit: exit({ code: null, problem: "timed out after 10 s" }),
      expected: failure("timed out after 10 s"),
    },
  ])("$name", ({ event, exit: hookExit, expected }) => {
    expect(interpretHookExit(event, "h", hookExit)).toEqual(expected);
  });

  it("merges in file order: any block wins, and the joined context is cut", () => {
    expect(
      mergeResults("PromptSubmit", [
        result(null, "first"),
        result("reason one", null),
        failure("crashed"),
        result("reason two", "second"),
      ]),
    ).toEqual({
      event: "PromptSubmit",
      blockReason: "reason one\n\nreason two",
      context: "first\n\nsecond",
    });

    const cut = mergeResults("SessionStart", [result(null, "x".repeat(MAX_CONTEXT_CHARS + 500))]);
    expect(cut.context).toHaveLength(MAX_CONTEXT_CHARS);
    expect(cut.context).toMatch(/was cut at 8,000 characters\]$/);
  });
});

describe("the failure rule", () => {
  const brokenStubs: ReadonlyArray<Stub> = [
    { events: ["PreTool"], exit: 3, stderr: "crashed" },
    { events: ["PreTool"], command: ["/bin/sh", "-c", "sleep 30"], timeout: 0.2 },
    { events: ["PreTool"], stdout: "not json" },
    { events: ["PreTool"], command: ["/nonexistent/hook"] },
  ];

  it("counts a failed hook as no decision, logs it, and keeps the other hooks", async () => {
    const sandbox = makeSandbox([
      ...brokenStubs,
      { events: ["PreTool"], exit: 2, stderr: "refused" },
    ]);

    expect(await sandbox.call("codex", "PreToolUse", recorded.codex.preToolUseShell)).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"refused"}}',
    );

    expect(sandbox.errors()).toMatchObject([
      {
        time: expect.stringMatching(/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        hook: "stub0",
        event: "PreTool",
        agent: "codex",
        problem: "exit code 3: crashed",
      },
      { hook: "stub1", problem: "timed out after 0.2 s" },
      { hook: "stub2", problem: "stdout is not JSON: not json" },
      { hook: "stub3", problem: expect.stringContaining("could not start") },
    ]);
  });

  it.each([
    { agent: "claude", payload: recorded.claude.preToolUseShell, neutral: "" },
    { agent: "codex", payload: recorded.codex.preToolUseShell, neutral: "" },
    { agent: "agy", payload: recorded.agy.preToolUseShell, neutral: '{"decision":"allow"}' },
  ] as const)("lets the call through on $agent when every hook fails", async (row) => {
    const sandbox = makeSandbox(brokenStubs);

    expect(await sandbox.call(row.agent, "PreToolUse", row.payload)).toBe(row.neutral);
    expect(sandbox.errors()).toHaveLength(4);
  });

  it("does not take a program with a folder part from the working folder of the agent", async () => {
    const sandbox = makeSandbox([{ events: ["PreTool"], command: ["tools/refuse.sh"] }]);
    const project = NodePath.join(sandbox.root, "project");
    NodeFS.mkdirSync(NodePath.join(project, "tools"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(project, "tools", "refuse.sh"),
      "#!/bin/sh\necho from the project >&2\nexit 2\n",
      { mode: 0o755 },
    );

    expect(
      await sandbox.call("claude", "PreToolUse", {
        ...recorded.claude.preToolUseShell,
        cwd: project,
      }),
    ).toBe("");
    expect(sandbox.errors()).toMatchObject([
      { hook: "stub0", problem: expect.stringContaining("could not start") },
    ]);
  });

  it("answers neutrally and logs when the runner itself cannot read the call", async () => {
    const sandbox = makeSandbox([]);

    expect(await handleHookCall("agy", "PreToolUse", "not json", sandbox.env)).toBe(
      '{"decision":"allow"}',
    );
    expect(await handleHookCall("claude", "Stop", "[]", sandbox.env)).toBe("");

    expect(sandbox.errors()).toMatchObject([
      {
        agent: "agy",
        native_event: "PreToolUse",
        problem: expect.stringContaining("runner error"),
      },
      { agent: "claude", native_event: "Stop" },
    ]);
  });
});

describe("the time of a log line", () => {
  it.each([
    [0, "1970-01-01T00:00:00.000Z"],
    [1_709_210_096_789, "2024-02-29T12:34:56.789Z"],
    [1_767_225_599_999, "2025-12-31T23:59:59.999Z"],
  ])("writes %d ms as %s", (ms, text) => {
    expect(isoTime(ms)).toBe(text);
  });
});

describe("the hook file", () => {
  const load = (content: string | null) => {
    const sandbox = makeSandbox([]);
    const file = NodePath.join(sandbox.env.AGENT_HOOKS_DIR, "hooks.json");
    if (content === null) NodeFS.rmSync(file);
    else NodeFS.writeFileSync(file, content);
    return loadConfig(runnerPaths(sandbox.env));
  };

  it("drops a bad entry, names it, and keeps the rest", () => {
    const config = load(
      JSON.stringify({
        version: 1,
        hooks: {
          good: { events: ["PreTool"], tools: ["shell"], command: ["~/bin/guard", "--strict"] },
          off: { events: ["Stop"], command: ["x"], enabled: false },
          unknown_event: { events: ["PreToolUse"], command: ["x"] },
          tools_on_stop: { events: ["Stop"], tools: ["shell"], command: ["x"] },
          no_command: { events: ["Stop"], command: [] },
          slow: { events: ["Stop"], command: ["x"], timeout: 600 },
          typo: { events: ["Stop"], command: ["x"], tool: ["shell"] },
        },
      }),
    );

    expect(config.hooks.map((hook) => hook.name)).toEqual(["good"]);
    expect(config.hooks[0]?.command[0]).toMatch(/\/bin\/guard$/);
    expect(config.hooks[0]?.command[0]).not.toContain("~");
    expect(config.problems).toEqual([
      'hook "unknown_event": "events" has the unknown value "PreToolUse"',
      'hook "tools_on_stop": "tools" is only for hooks whose events are all PreTool or PostTool',
      'hook "no_command": "command" must be a list of strings that starts with a program',
      'hook "slow": "timeout" must be a number of seconds from above 0 to 590',
      'hook "typo": unknown key "tool"',
    ]);
  });

  it("reads a missing file as no hooks and a broken file as a problem", () => {
    expect(load(null)).toEqual({ hooks: [], problems: [] });
    expect(load("{").hooks).toEqual([]);
    expect(load("{").problems).toHaveLength(1);
    expect(load('{"version":2,"hooks":{}}').problems).toHaveLength(1);
  });
});
