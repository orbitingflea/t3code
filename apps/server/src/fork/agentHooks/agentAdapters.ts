import {
  type Agent,
  type Decision,
  epochMs,
  isMissingFile,
  isObject,
  type JsonObject,
  type Occurrence,
  readTextIfPresent,
  type RunnerPaths,
  stringOr,
  type ToolCall,
  type ToolClass,
  writeFileAtomic,
} from "./shapes.ts";

const NodeFS = process.getBuiltinModule("node:fs");
const NodePath = process.getBuiltinModule("node:path");

const TOOL_CLASS_BY_NAME: Readonly<Record<Agent, Readonly<Record<string, ToolClass>>>> = {
  claude: {
    Bash: "shell",
    Write: "edit",
    Edit: "edit",
    MultiEdit: "edit",
    NotebookEdit: "edit",
    Read: "read",
    Grep: "search",
    Glob: "search",
    Agent: "agent",
    Task: "agent",
    Workflow: "agent",
  },
  codex: {
    Bash: "shell",
    apply_patch: "edit",
    spawn_agent: "agent",
    send_input: "agent",
    close_agent: "agent",
  },
  agy: {
    run_command: "shell",
    write_file: "edit",
    edit_file: "edit",
    write_to_file: "edit",
    replace_file_content: "edit",
    multi_replace_file_content: "edit",
    read_file: "read",
    view_file: "read",
    grep_search: "search",
    find_by_name: "search",
    list_dir: "search",
    call_mcp_tool: "mcp",
    invoke_subagent: "agent",
    define_subagent: "agent",
    manage_subagents: "agent",
    send_message: "agent",
    swarm: "agent",
  },
};

const MCP_PREFIX: Readonly<Record<Agent, string>> = {
  claude: "mcp__",
  codex: "mcp__",
  agy: "mcp_",
};

const PATH_KEYS: Readonly<Record<Agent, ReadonlyArray<string>>> = {
  claude: ["file_path", "notebook_path", "path"],
  codex: [],
  agy: [
    "Path",
    "AbsolutePath",
    "TargetFile",
    "FilePath",
    "File",
    "DirectoryPath",
    "Directory",
    "SearchDirectory",
    "SearchPath",
    "NotebookPath",
  ],
};

const PATCH_FILE_LINE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

const toolCall = (
  agent: Agent,
  name: string,
  args: JsonObject,
  toolUseId: string,
  cwd: string,
): ToolCall => {
  const table = TOOL_CLASS_BY_NAME[agent];
  const toolClass: ToolClass = Object.hasOwn(table, name)
    ? (table[name] ?? "other")
    : name.startsWith(MCP_PREFIX[agent])
      ? "mcp"
      : "other";
  const named =
    agent === "codex" && toolClass === "edit"
      ? [...stringOr(args.command, "").matchAll(PATCH_FILE_LINE)].map((match) => match[1] ?? "")
      : PATH_KEYS[agent].flatMap((key) => (typeof args[key] === "string" ? [args[key]] : []));
  const filePaths = [...new Set(named.map((path) => NodePath.resolve(cwd, path.trim())))];
  let toolInput = args;
  if (agent === "agy") {
    toolInput = { ...args };
    if (toolClass === "shell") toolInput.command = stringOr(args.CommandLine, "");
    else if (filePaths[0] !== undefined) toolInput.file_path = filePaths[0];
  }
  return {
    toolClass,
    toolName: toolClass === "shell" ? "Bash" : name,
    toolInput,
    filePaths,
    toolUseId,
  };
};

interface Parsed {
  readonly occurrences: ReadonlyArray<Occurrence>;
  readonly agyCursor?: number;
}

interface AgentAdapter {
  readonly parse: (nativeEvent: string, raw: JsonObject, paths: RunnerPaths) => Parsed;
  readonly render: (
    nativeEvent: string,
    raw: JsonObject,
    decisions: ReadonlyArray<Decision>,
    parsed: Parsed,
    paths: RunnerPaths,
  ) => string;
}

const NOTHING_HAPPENED: Parsed = { occurrences: [] };

const claudeLikeAdapter = (agent: "claude" | "codex"): AgentAdapter => ({
  parse: (nativeEvent, raw) => {
    const base = {
      agent,
      sessionId: stringOr(raw.session_id, ""),
      cwd: stringOr(raw.cwd, process.cwd()),
      transcriptPath: stringOr(raw.transcript_path, null),
      native: raw,
    };
    const one = (occurrence: Occurrence): Parsed => ({ occurrences: [occurrence] });
    switch (nativeEvent) {
      case "SessionStart": {
        const source = stringOr(raw.source, "");
        if (source === "compact") return one({ ...base, event: "PostCompact", source });
        if (source === "startup" || source === "clear") {
          return one({ ...base, event: "SessionStart", source });
        }
        return NOTHING_HAPPENED;
      }
      case "UserPromptSubmit":
        return one({ ...base, event: "PromptSubmit", prompt: stringOr(raw.prompt, "") });
      case "PreToolUse":
      case "PostToolUse":
        return one({
          ...base,
          event: nativeEvent === "PreToolUse" ? "PreTool" : "PostTool",
          tool: toolCall(
            agent,
            stringOr(raw.tool_name, ""),
            isObject(raw.tool_input) ? raw.tool_input : {},
            stringOr(raw.tool_use_id, ""),
            base.cwd,
          ),
          toolResponse: raw.tool_response,
        });
      case "Stop":
        return one({
          ...base,
          event: "Stop",
          lastAssistantMessage: stringOr(raw.last_assistant_message, ""),
          stopHookActive: raw.stop_hook_active === true,
        });
      default:
        return NOTHING_HAPPENED;
    }
  },
  // Only these fields are printed: Codex fails a hook run on a field it does not know, and a
  // PostToolUse block would replace the tool result there, so feedback is always sent as context.
  render: (nativeEvent, _raw, decisions) => {
    const decision = decisions[0];
    if (decision === undefined) return "";
    if (decision.blockReason !== null) {
      return JSON.stringify(
        decision.event === "PreTool"
          ? {
              hookSpecificOutput: {
                hookEventName: nativeEvent,
                permissionDecision: "deny",
                permissionDecisionReason: decision.blockReason,
              },
            }
          : { decision: "block", reason: decision.blockReason },
      );
    }
    if (decision.context !== null) {
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: nativeEvent, additionalContext: decision.context },
      });
    }
    return "";
  },
});

// A PreToolUse answer of {} denies the call in agy; "allow" hands it on to agy's own permission check.
const AGY_NEUTRAL_PRETOOL = '{"decision":"allow"}';
const AGY_STOP_CONTINUED_MARK = "Stop hook blocked termination";
const AGY_STATE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;

interface AgyStep {
  readonly index: number;
  readonly type: string;
  readonly source: string;
  readonly content: string;
  readonly hasToolCalls: boolean;
}

function* linesFromEnd(path: string): Generator<string> {
  const fd = NodeFS.openSync(path, "r");
  try {
    let position = NodeFS.fstatSync(fd).size;
    let rest: Buffer = Buffer.alloc(0);
    while (position > 0) {
      const size = Math.min(TRANSCRIPT_CHUNK_BYTES, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      NodeFS.readSync(fd, chunk, 0, size, position);
      const data = Buffer.concat([chunk, rest]);
      let lineEnd = data.length;
      for (
        let newline = data.lastIndexOf(0x0a);
        newline >= 0;
        newline = newline > 0 ? data.lastIndexOf(0x0a, newline - 1) : -1
      ) {
        if (lineEnd > newline + 1) yield data.subarray(newline + 1, lineEnd).toString("utf8");
        lineEnd = newline;
      }
      rest = data.subarray(0, lineEnd);
    }
    if (rest.length > 0) yield rest.toString("utf8");
  } finally {
    NodeFS.closeSync(fd);
  }
}

function* agyStepsFromEnd(transcriptPath: string): Generator<AgyStep> {
  for (const line of linesFromEnd(transcriptPath)) {
    let step: unknown;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(step) || typeof step.step_index !== "number") continue;
    yield {
      index: step.step_index,
      type: stringOr(step.type, ""),
      source: stringOr(step.source, ""),
      content: stringOr(step.content, ""),
      hasToolCalls: Array.isArray(step.tool_calls) && step.tool_calls.length > 0,
    };
  }
}

const agyStepsAfter = (transcriptPath: string, cursor: number | null): ReadonlyArray<AgyStep> => {
  const steps: Array<AgyStep> = [];
  for (const step of agyStepsFromEnd(transcriptPath)) {
    if (cursor !== null && step.index <= cursor) break;
    steps.push(step);
    if (cursor === null && step.type === "USER_INPUT") break;
  }
  return steps;
};

const agyTurnEnd = (transcriptPath: string): { message: string; continued: boolean } => {
  let message: string | null = null;
  for (const step of agyStepsFromEnd(transcriptPath)) {
    if (step.type === "USER_INPUT") break;
    if (step.type === "SYSTEM_MESSAGE" && step.content.includes(AGY_STOP_CONTINUED_MARK)) {
      return { message: message ?? "", continued: true };
    }
    if (message === null && step.source === "MODEL" && step.type === "PLANNER_RESPONSE") {
      message = step.hasToolCalls ? "" : step.content;
    }
  }
  return { message: message ?? "", continued: false };
};

const agyStateDir = (paths: RunnerPaths, conversationId: string): string =>
  NodePath.join(paths.stateDir, "agy", conversationId.replace(/[^A-Za-z0-9._-]/g, "_") || "_");

const loadAgyCursor = (paths: RunnerPaths, conversationId: string): number | null => {
  try {
    const text = readTextIfPresent(
      NodePath.join(agyStateDir(paths, conversationId), "cursor.json"),
    );
    const cursor: unknown = text === null ? null : JSON.parse(text);
    return isObject(cursor) && typeof cursor.step === "number" ? cursor.step : null;
  } catch {
    return null;
  }
};

const saveAgyCursor = (paths: RunnerPaths, conversationId: string, step: number): void =>
  writeFileAtomic(
    NodePath.join(agyStateDir(paths, conversationId), "cursor.json"),
    JSON.stringify({ step }),
  );

const putAgyPending = (
  paths: RunnerPaths,
  conversationId: string,
  stepIndex: number,
  toolUseId: string,
  context: string,
): void => {
  const name = `${String(stepIndex).padStart(8, "0")}-${toolUseId.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`;
  writeFileAtomic(NodePath.join(agyStateDir(paths, conversationId), "pending", name), context);
};

const takeAgyPending = (paths: RunnerPaths, conversationId: string): ReadonlyArray<string> => {
  const folder = NodePath.join(agyStateDir(paths, conversationId), "pending");
  let names: Array<string>;
  try {
    names = NodeFS.readdirSync(folder)
      .filter((name) => name.endsWith(".txt"))
      .sort();
  } catch (cause) {
    if (isMissingFile(cause)) return [];
    throw cause;
  }
  const contexts: Array<string> = [];
  for (const name of names) {
    const claimed = NodePath.join(folder, `${name}.${process.pid}.claimed`);
    try {
      NodeFS.renameSync(NodePath.join(folder, name), claimed);
    } catch (cause) {
      if (isMissingFile(cause)) continue;
      throw cause;
    }
    contexts.push(NodeFS.readFileSync(claimed, "utf8"));
    NodeFS.rmSync(claimed);
  }
  return contexts;
};

const dropOldAgyState = (paths: RunnerPaths): void => {
  const root = NodePath.join(paths.stateDir, "agy");
  let names: Array<string>;
  try {
    names = NodeFS.readdirSync(root);
  } catch {
    return;
  }
  const oldest = epochMs() - AGY_STATE_MAX_AGE_MS;
  for (const name of names) {
    const folder = NodePath.join(root, name);
    try {
      if (NodeFS.statSync(folder).mtimeMs < oldest) {
        NodeFS.rmSync(folder, { recursive: true, force: true });
      }
    } catch {
      continue;
    }
  }
};

const agySystemMessage = (text: string): JsonObject => ({ systemMessage: { systemMessage: text } });

const agyInjection = (steps: ReadonlyArray<JsonObject>, extra: JsonObject = {}): string =>
  JSON.stringify(steps.length > 0 ? { injectSteps: steps, ...extra } : extra);

const isAgyCompactCommand = (prompt: string): boolean => /^\/compact(\s|$)/.test(prompt.trim());

const agyAdapter: AgentAdapter = {
  parse: (nativeEvent, raw, paths) => {
    const workspace = Array.isArray(raw.workspacePaths) ? raw.workspacePaths[0] : undefined;
    const conversationId = stringOr(raw.conversationId, "");
    const transcriptPath = stringOr(raw.transcriptPath, null);
    const base = {
      agent: "agy" as const,
      sessionId: conversationId,
      cwd: stringOr(raw.cwd, stringOr(workspace, process.cwd())),
      transcriptPath,
      native: raw,
    };
    switch (nativeEvent) {
      case "SessionStart":
        dropOldAgyState(paths);
        return { occurrences: [{ ...base, event: "SessionStart", source: "startup" }] };
      case "PreInvocation": {
        const cursor = loadAgyCursor(paths, conversationId);
        const prompt = stringOr(raw.lastUserInput, "");
        let steps: ReadonlyArray<AgyStep> | null = null;
        try {
          if (transcriptPath !== null) steps = agyStepsAfter(transcriptPath, cursor);
        } catch (cause) {
          if (!isMissingFile(cause)) throw cause;
        }
        // agy writes the prompt to the transcript before this hook runs; without a transcript the
        // first model call of a turn is the only sign of a new prompt.
        const newPrompt =
          steps === null
            ? (raw.invocationNum ?? 0) === 0
            : steps.some((step) => step.type === "USER_INPUT");
        const compacted = steps !== null && steps.some((step) => step.type === "CHECKPOINT");
        const occurrences: Array<Occurrence> = [];
        if (compacted) occurrences.push({ ...base, event: "PostCompact", source: "compact" });
        if (newPrompt && !isAgyCompactCommand(prompt)) {
          occurrences.push({ ...base, event: "PromptSubmit", prompt });
        }
        return { occurrences, agyCursor: steps?.[0]?.index ?? cursor ?? -1 };
      }
      case "PreToolUse":
      case "PostToolUse": {
        const call = isObject(raw.toolCall) ? raw.toolCall : {};
        if (nativeEvent === "PostToolUse" && stringOr(raw.error, "") !== "")
          return NOTHING_HAPPENED;
        return {
          occurrences: [
            {
              ...base,
              event: nativeEvent === "PreToolUse" ? "PreTool" : "PostTool",
              tool: toolCall(
                "agy",
                stringOr(call.name, ""),
                isObject(call.args) ? call.args : {},
                stringOr(call.id, ""),
                base.cwd,
              ),
            },
          ],
        };
      }
      case "Stop": {
        if (raw.terminationReason !== "NO_TOOL_CALL") return NOTHING_HAPPENED;
        let reply = { message: "", continued: (raw.executionNum ?? 0) !== 0 };
        try {
          if (transcriptPath !== null) reply = agyTurnEnd(transcriptPath);
        } catch (cause) {
          if (!isMissingFile(cause)) throw cause;
        }
        return {
          occurrences: [
            {
              ...base,
              event: "Stop",
              lastAssistantMessage: reply.message,
              stopHookActive: reply.continued,
            },
          ],
        };
      }
      default:
        return NOTHING_HAPPENED;
    }
  },
  render: (nativeEvent, raw, decisions, parsed, paths) => {
    const conversationId = stringOr(raw.conversationId, "");
    const contexts = decisions.flatMap((decision) =>
      decision.context === null ? [] : [decision.context],
    );
    const blockReason = decisions.find((decision) => decision.blockReason !== null)?.blockReason;
    switch (nativeEvent) {
      case "SessionStart":
      case "PreInvocation": {
        const steps = [
          ...(nativeEvent === "PreInvocation" ? takeAgyPending(paths, conversationId) : []),
          ...contexts,
        ].map(agySystemMessage);
        if (parsed.agyCursor !== undefined) saveAgyCursor(paths, conversationId, parsed.agyCursor);
        return blockReason === undefined
          ? agyInjection(steps)
          : agyInjection([...steps, { errorMessage: { userMessage: blockReason } }], {
              terminationBehavior: "terminate",
            });
      }
      case "PostInvocation":
        return agyInjection(takeAgyPending(paths, conversationId).map(agySystemMessage));
      case "PreToolUse":
        return blockReason === undefined
          ? AGY_NEUTRAL_PRETOOL
          : JSON.stringify({ decision: "deny", reason: blockReason });
      case "PostToolUse": {
        const call = isObject(raw.toolCall) ? raw.toolCall : {};
        for (const context of contexts) {
          putAgyPending(
            paths,
            conversationId,
            typeof raw.stepIdx === "number" ? raw.stepIdx : 0,
            stringOr(call.id, ""),
            context,
          );
        }
        return "{}";
      }
      case "Stop":
        return blockReason === undefined
          ? "{}"
          : JSON.stringify({ decision: "continue", reason: blockReason });
      default:
        return "{}";
    }
  },
};

export const ADAPTERS: Readonly<Record<Agent, AgentAdapter>> = {
  claude: claudeLikeAdapter("claude"),
  codex: claudeLikeAdapter("codex"),
  agy: agyAdapter,
};

export const neutralOutput = (agent: Agent, nativeEvent: string): string =>
  agent === "agy" ? (nativeEvent === "PreToolUse" ? AGY_NEUTRAL_PRETOOL : "{}") : "";
