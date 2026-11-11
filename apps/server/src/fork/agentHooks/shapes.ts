// The modules of this folder are installed as type-stripped copies that run on plain Node, so they use only
// Node builtins and erasable syntax. They take the builtins from process.getBuiltinModule, because a static
// import of them adds several milliseconds to every hook call.
const NodeFS = process.getBuiltinModule("node:fs");
const NodeOS = process.getBuiltinModule("node:os");
const NodePath = process.getBuiltinModule("node:path");

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stringOr = <T>(value: unknown, fallback: T): string | T =>
  typeof value === "string" ? value : fallback;

export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const isMissingFile = (cause: unknown): boolean =>
  isObject(cause) && (cause.code === "ENOENT" || cause.code === "ENOTDIR");

export const readTextIfPresent = (path: string): string | null => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
};

export const writeFileAtomic = (path: string, content: string, mode?: number): void => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, content, mode === undefined ? {} : { mode });
  NodeFS.renameSync(temporary, path);
};

/** Milliseconds since 1970, from the clock of this process. */
export const epochMs = (): number => performance.timeOrigin + performance.now();

/** A time in milliseconds since 1970 as UTC text, such as `2026-01-31T09:05:00.250Z`. */
export const isoTime = (ms: number): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  }).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}.${part("fractionalSecond")}Z`;
};

export const EVENTS = [
  "SessionStart",
  "PromptSubmit",
  "PreTool",
  "PostTool",
  "Stop",
  "PostCompact",
] as const;
export type UnifiedEvent = (typeof EVENTS)[number];

export const AGENTS = ["claude", "codex", "agy"] as const;
export type Agent = (typeof AGENTS)[number];

export const TOOL_CLASSES = ["shell", "edit", "read", "search", "mcp", "agent", "other"] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

const CLAUDE_EVENT_NAME: Readonly<Record<UnifiedEvent, string>> = {
  SessionStart: "SessionStart",
  PostCompact: "SessionStart",
  PromptSubmit: "UserPromptSubmit",
  PreTool: "PreToolUse",
  PostTool: "PostToolUse",
  Stop: "Stop",
};

export interface RunnerPaths {
  readonly home: string;
  readonly hooksDir: string;
  readonly stateDir: string;
}

export const runnerPaths = (env: NodeJS.ProcessEnv): RunnerPaths => {
  // An empty variable counts as not set, so that no path is taken relative to the working folder.
  const home = env.HOME || NodeOS.homedir();
  return {
    home,
    hooksDir: env.AGENT_HOOKS_DIR || NodePath.join(home, ".agents", "hooks"),
    stateDir: NodePath.join(
      env.XDG_STATE_HOME || NodePath.join(home, ".local", "state"),
      "agent-hooks",
    ),
  };
};

export interface HookSpec {
  readonly name: string;
  readonly events: ReadonlySet<UnifiedEvent>;
  readonly tools: ReadonlySet<ToolClass> | null;
  readonly command: ReadonlyArray<string>;
  readonly agents: ReadonlySet<Agent>;
  readonly timeoutSeconds: number;
}

export interface HookConfig {
  readonly hooks: ReadonlyArray<HookSpec>;
  readonly problems: ReadonlyArray<string>;
}

export interface ToolCall {
  readonly toolClass: ToolClass;
  readonly toolName: string;
  readonly toolInput: JsonObject;
  readonly filePaths: ReadonlyArray<string>;
  readonly toolUseId: string;
}

export interface Occurrence {
  readonly event: UnifiedEvent;
  readonly agent: Agent;
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath: string | null;
  readonly native: JsonObject;
  readonly source?: string;
  readonly prompt?: string;
  readonly tool?: ToolCall;
  readonly lastAssistantMessage?: string;
  readonly stopHookActive?: boolean;
}

export interface HookResult {
  readonly hook: string;
  readonly blockReason: string | null;
  readonly context: string | null;
  readonly failure: string | null;
}

export interface Decision {
  readonly event: UnifiedEvent;
  readonly blockReason: string | null;
  readonly context: string | null;
}

export const hookStdin = (occurrence: Occurrence): JsonObject => {
  const payload: JsonObject = {
    ...occurrence.native,
    hook_event_name: CLAUDE_EVENT_NAME[occurrence.event],
    event: occurrence.event,
    agent: occurrence.agent,
    session_id: occurrence.sessionId,
    cwd: occurrence.cwd,
    transcript_path: occurrence.transcriptPath,
  };
  if (occurrence.source !== undefined) payload.source = occurrence.source;
  if (occurrence.prompt !== undefined) payload.prompt = occurrence.prompt;
  if (occurrence.tool !== undefined) {
    payload.tool_class = occurrence.tool.toolClass;
    payload.tool_name = occurrence.tool.toolName;
    payload.tool_input = occurrence.tool.toolInput;
    payload.file_paths = occurrence.tool.filePaths;
    payload.tool_use_id = occurrence.tool.toolUseId;
  }
  // agy gives a hook no tool result, so the unified fields have none on any agent; `native` keeps it.
  if (occurrence.event === "PostTool") delete payload.tool_response;
  if (occurrence.event === "Stop") {
    payload.last_assistant_message = occurrence.lastAssistantMessage ?? "";
    payload.stop_hook_active = occurrence.stopHookActive ?? false;
  }
  payload.native = occurrence.native;
  return payload;
};
