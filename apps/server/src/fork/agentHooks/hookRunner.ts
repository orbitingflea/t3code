import { ADAPTERS, neutralOutput } from "./agentAdapters.ts";
import { findProject, type Project } from "./projectHooks.ts";
import {
  type Agent,
  AGENTS,
  type Decision,
  errorText,
  epochMs,
  EVENTS,
  type HookConfig,
  type HookResult,
  type HookSpec,
  hookStdin,
  isMissingFile,
  isoTime,
  isObject,
  type JsonObject,
  type Occurrence,
  readTextIfPresent,
  type RunnerPaths,
  runnerPaths,
  stringOr,
  TOOL_CLASSES,
  type ToolClass,
  type UnifiedEvent,
  userHookFile,
} from "./shapes.ts";

const NodeFS = process.getBuiltinModule("node:fs");
const NodePath = process.getBuiltinModule("node:path");

const TOOL_EVENTS: ReadonlySet<UnifiedEvent> = new Set(["PreTool", "PostTool"]);
const CAN_BLOCK: ReadonlySet<UnifiedEvent> = new Set(["PromptSubmit", "PreTool", "Stop"]);
const CAN_CONTEXT: ReadonlySet<UnifiedEvent> = new Set([
  "SessionStart",
  "PromptSubmit",
  "PostTool",
  "PostCompact",
]);

export const MAX_CONTEXT_CHARS = 8000;
const CONTEXT_CUT_NOTICE = "\n[agent-hooks: the hook context was cut at 8,000 characters]";
const DEFAULT_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 590;
const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;
const MAX_ERROR_LOG_BYTES = 1024 * 1024;

const HOOK_KEYS: ReadonlySet<string> = new Set([
  "events",
  "tools",
  "command",
  "agents",
  "timeout",
  "enabled",
]);

const expandHome = (value: string, home: string): string =>
  value === "~" ? home : value.startsWith("~/") ? NodePath.join(home, value.slice(2)) : value;

const parseMembers = <T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  label: string,
): ReadonlySet<T> | string => {
  if (!Array.isArray(value) || value.length === 0) return `"${label}" must be a non-empty list`;
  const members = new Set<T>();
  for (const item of value) {
    const match = allowed.find((candidate) => candidate === item);
    if (match === undefined) return `"${label}" has the unknown value ${JSON.stringify(item)}`;
    members.add(match);
  }
  return members;
};

type ParsedHook = Omit<HookSpec, "dir" | "project">;

const parseHookSpec = (name: string, entry: unknown, home: string): ParsedHook | string | null => {
  if (/^\d+$/.test(name)) return "the name must not be a number";
  if (!isObject(entry)) return "must be an object";
  const unknownKey = Object.keys(entry).find((key) => !HOOK_KEYS.has(key));
  if (unknownKey !== undefined) return `unknown key "${unknownKey}"`;
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
    return '"enabled" must be true or false';
  }
  const events = parseMembers(entry.events, EVENTS, "events");
  if (typeof events === "string") return events;
  let tools: ReadonlySet<ToolClass> | null = null;
  if (entry.tools !== undefined) {
    if ([...events].some((event) => !TOOL_EVENTS.has(event))) {
      return '"tools" is only for hooks whose events are all PreTool or PostTool';
    }
    const parsed = parseMembers(entry.tools, TOOL_CLASSES, "tools");
    if (typeof parsed === "string") return parsed;
    tools = parsed;
  }
  const agents =
    entry.agents === undefined ? new Set(AGENTS) : parseMembers(entry.agents, AGENTS, "agents");
  if (typeof agents === "string") return agents;
  const command = entry.command;
  if (
    !Array.isArray(command) ||
    !command.every((part): part is string => typeof part === "string") ||
    (command[0] ?? "") === ""
  ) {
    return '"command" must be a list of strings that starts with a program';
  }
  const timeout = entry.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  if (typeof timeout !== "number" || !(timeout > 0) || timeout > MAX_TIMEOUT_SECONDS) {
    return `"timeout" must be a number of seconds from above 0 to ${MAX_TIMEOUT_SECONDS}`;
  }
  if (entry.enabled === false) return null;
  return {
    name,
    events,
    tools,
    command: command.map((part) => expandHome(part, home)),
    agents,
    timeoutSeconds: timeout,
  };
};

/** A hook's name in the error log. A project hook is marked, so it differs from a user hook of the same name. */
const hookLabel = (spec: HookSpec): string =>
  spec.project === null ? spec.name : `project:${spec.name}`;

/** A hook's name in a message for the user. */
export const hookTitle = (name: string, project: string | null): string =>
  `${project === null ? "hook" : "project hook"} "${name}"`;

const NO_HOOKS: HookConfig = { hooks: [], problems: [] };

const loadHookFile = (file: string, home: string, project: string | null): HookConfig => {
  let parsed: unknown;
  try {
    const text = readTextIfPresent(file);
    if (text === null) return { hooks: [], problems: [] };
    parsed = JSON.parse(text);
  } catch (cause) {
    return { hooks: [], problems: [`${file}: ${errorText(cause)}`] };
  }
  if (!isObject(parsed) || !isObject(parsed.hooks)) {
    return { hooks: [], problems: [`${file}: expected {"version": 1, "hooks": {...}}`] };
  }
  if (parsed.version !== undefined && parsed.version !== 1) {
    return {
      hooks: [],
      problems: [`${file}: version ${JSON.stringify(parsed.version)} is not supported`],
    };
  }
  const hooks: Array<HookSpec> = [];
  const problems: Array<string> = [];
  for (const [name, entry] of Object.entries(parsed.hooks)) {
    const spec = parseHookSpec(name, entry, home);
    if (typeof spec === "string") {
      problems.push(`${hookTitle(name, project)}: ${spec}`);
    } else if (spec !== null) hooks.push({ ...spec, dir: NodePath.dirname(file), project });
  }
  return { hooks, problems };
};

export const loadConfig = (paths: RunnerPaths): HookConfig =>
  loadHookFile(userHookFile(paths), paths.home, null);

/** The hooks of a project's own file. A project that is not trusted has none: its file is not read. */
export const loadProjectConfig = (project: Project | null, paths: RunnerPaths): HookConfig =>
  project?.trusted ? loadHookFile(project.file, paths.home, project.folder) : NO_HOOKS;

const selectHooks = (
  hooks: ReadonlyArray<HookSpec>,
  occurrence: Occurrence,
): ReadonlyArray<HookSpec> =>
  hooks.filter(
    (spec) =>
      spec.events.has(occurrence.event) &&
      spec.agents.has(occurrence.agent) &&
      (spec.tools === null ||
        (occurrence.tool !== undefined && spec.tools.has(occurrence.tool.toolClass))),
  );

export const resolveProgram = (program: string, hooksDir: string): string => {
  if (NodePath.isAbsolute(program)) return program;
  const local = NodePath.join(hooksDir, program);
  // A program with a folder part is never left to the system, which would take it from the working folder.
  return NodeFS.existsSync(local) || program.includes(NodePath.sep) ? local : program;
};

export interface HookExit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly problem: string | null;
}

const failed = (hook: string, failure: string): HookResult => ({
  hook,
  blockReason: null,
  context: null,
  failure,
});

export const interpretHookExit = (
  event: UnifiedEvent,
  hook: string,
  exit: HookExit,
): HookResult => {
  if (exit.problem !== null) return failed(hook, exit.problem);
  let blockReason: string | null = null;
  const contexts: Array<string> = [];
  if (exit.code === 2) {
    blockReason = exit.stderr.trim();
    if (blockReason === "") return failed(hook, "exit code 2 with nothing on stderr");
  } else if (exit.code !== 0) {
    return failed(hook, `exit code ${exit.code}: ${exit.stderr.trim().slice(-500)}`);
  } else if (exit.stdout.trim() !== "") {
    let output: unknown;
    try {
      output = JSON.parse(exit.stdout);
    } catch {
      return failed(hook, `stdout is not JSON: ${exit.stdout.trim().slice(0, 200)}`);
    }
    if (!isObject(output)) return failed(hook, "stdout is not a JSON object");
    const specific = isObject(output.hookSpecificOutput) ? output.hookSpecificOutput : {};
    if (output.decision === "block" || specific.permissionDecision === "deny") {
      blockReason = stringOr(output.reason, stringOr(specific.permissionDecisionReason, "")).trim();
      if (blockReason === "") return failed(hook, "a block without a reason");
    }
    for (const context of [output.context, specific.additionalContext]) {
      if (typeof context === "string" && context.trim() !== "") contexts.push(context);
    }
  }
  if (blockReason !== null && event === "PostTool") {
    contexts.unshift(blockReason);
    blockReason = null;
  }
  if (blockReason !== null && !CAN_BLOCK.has(event)) {
    return failed(hook, `${event} cannot block`);
  }
  if (contexts.length > 0 && !CAN_CONTEXT.has(event)) {
    return failed(hook, `${event} cannot add context`);
  }
  return {
    hook,
    blockReason,
    context: contexts.length > 0 ? contexts.join("\n\n") : null,
    failure: null,
  };
};

export const mergeResults = (event: UnifiedEvent, results: ReadonlyArray<HookResult>): Decision => {
  const reasons = results.flatMap((result) =>
    result.blockReason === null ? [] : [result.blockReason],
  );
  const contexts = results.flatMap((result) => (result.context === null ? [] : [result.context]));
  let context = contexts.length > 0 ? contexts.join("\n\n") : null;
  if (context !== null && context.length > MAX_CONTEXT_CHARS) {
    context = context.slice(0, MAX_CONTEXT_CHARS - CONTEXT_CUT_NOTICE.length) + CONTEXT_CUT_NOTICE;
  }
  return { event, blockReason: reasons.length > 0 ? reasons.join("\n\n") : null, context };
};

const runHook = async (
  spec: HookSpec,
  occurrence: Occurrence,
  stdin: string,
): Promise<HookResult> => {
  const NodeChildProcess = process.getBuiltinModule("node:child_process");
  const { setTimeout: startTimer, clearTimeout: stopTimer } =
    process.getBuiltinModule("node:timers");
  const [program = "", ...args] = spec.command;
  const exit = await new Promise<HookExit>((resolve) => {
    const output = { stdout: "", stderr: "" };
    let problem: string | null = null;
    const start = () => {
      try {
        return NodeChildProcess.spawn(resolveProgram(program, spec.dir), args, {
          ...(NodeFS.existsSync(occurrence.cwd) ? { cwd: occurrence.cwd } : {}),
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (cause) {
        return `could not start: ${errorText(cause)}`;
      }
    };
    const child = start();
    if (typeof child === "string") {
      resolve({ code: null, ...output, problem: child });
      return;
    }
    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (output[stream].length < MAX_HOOK_OUTPUT_BYTES) output[stream] += chunk.toString("utf8");
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
    const timer = startTimer(() => {
      problem = `timed out after ${spec.timeoutSeconds} s`;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, spec.timeoutSeconds * 1000);
    const finish = (code: number | null) => {
      stopTimer(timer);
      resolve({ code, stdout: output.stdout, stderr: output.stderr, problem });
    };
    child.on("error", (cause) => {
      problem = `could not start: ${errorText(cause)}`;
      finish(null);
    });
    child.on("close", (code, signal) => {
      if (problem === null && code === null) problem = `ended by signal ${signal}`;
      finish(code);
    });
  });
  return interpretHookExit(occurrence.event, hookLabel(spec), exit);
};

const runHooks = (
  specs: ReadonlyArray<HookSpec>,
  occurrence: Occurrence,
): Promise<ReadonlyArray<HookResult>> => {
  const stdin = JSON.stringify(hookStdin(occurrence));
  return Promise.all(specs.map((spec) => runHook(spec, occurrence, stdin)));
};

export const errorLogPath = (paths: RunnerPaths): string =>
  NodePath.join(paths.stateDir, "errors.jsonl");

const logError = (paths: RunnerPaths, record: JsonObject): void => {
  try {
    const file = errorLogPath(paths);
    NodeFS.mkdirSync(paths.stateDir, { recursive: true });
    try {
      if (NodeFS.statSync(file).size > MAX_ERROR_LOG_BYTES) NodeFS.renameSync(file, `${file}.1`);
    } catch (cause) {
      if (!isMissingFile(cause)) throw cause;
    }
    NodeFS.appendFileSync(file, `${JSON.stringify({ time: isoTime(epochMs()), ...record })}\n`);
  } catch {
    // A full disk or a read-only state folder must not turn a hook call into an agent error.
  }
};

const decide = async (
  occurrence: Occurrence,
  hooks: ReadonlyArray<HookSpec>,
  paths: RunnerPaths,
): Promise<Decision> => {
  const specs = selectHooks(hooks, occurrence);
  if (specs.length === 0) return { event: occurrence.event, blockReason: null, context: null };
  const results = await runHooks(specs, occurrence);
  for (const [index, result] of results.entries()) {
    if (result.failure === null) continue;
    const project = specs[index]?.project ?? null;
    logError(paths, {
      hook: result.hook,
      ...(project === null ? {} : { project }),
      event: occurrence.event,
      agent: occurrence.agent,
      session_id: occurrence.sessionId,
      problem: result.failure,
    });
  }
  return mergeResults(occurrence.event, results);
};

/** One native hook call: the exact text to print for the agent. It never throws. */
export const handleHookCall = async (
  agent: Agent,
  nativeEvent: string,
  stdinText: string,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  const paths = runnerPaths(env);
  let output = neutralOutput(agent, nativeEvent);
  let events: ReadonlyArray<UnifiedEvent> = [];
  try {
    const raw: unknown = JSON.parse(stdinText);
    if (!isObject(raw)) throw new Error("the hook input is not a JSON object");
    const adapter = ADAPTERS[agent];
    const parsed = adapter.parse(nativeEvent, raw, paths);
    events = parsed.occurrences.map((occurrence) => occurrence.event);
    let decisions: ReadonlyArray<Decision> = [];
    const [first] = parsed.occurrences;
    if (first !== undefined) {
      const config = loadConfig(paths);
      const project = findProject(first.cwd, paths);
      const projectConfig = loadProjectConfig(project, paths);
      if (nativeEvent === "SessionStart") {
        for (const problem of config.problems) logError(paths, { agent, problem });
        for (const problem of projectConfig.problems) {
          logError(paths, { agent, project: project?.folder, problem });
        }
      }
      // The user's hooks come first, so their answers are merged before the project's.
      const hooks = [...config.hooks, ...projectConfig.hooks];
      // The hooks of every event of the call run together, so the call ends within one hook timeout.
      decisions = await Promise.all(
        parsed.occurrences.map((occurrence) => decide(occurrence, hooks, paths)),
      );
    }
    output = adapter.render(nativeEvent, raw, decisions, parsed, paths);
  } catch (cause) {
    logError(paths, {
      agent,
      native_event: nativeEvent,
      problem: `runner error: ${errorText(cause)}`,
    });
  }
  if (env.AGENT_HOOKS_TRACE !== undefined && env.AGENT_HOOKS_TRACE !== "") {
    try {
      NodeFS.appendFileSync(
        env.AGENT_HOOKS_TRACE,
        `${JSON.stringify({ time: isoTime(epochMs()), agent, native_event: nativeEvent, stdin: stdinText, events, stdout: output })}\n`,
      );
    } catch {
      // The trace is a debugging aid; a bad path must not change the answer.
    }
  }
  return output;
};
