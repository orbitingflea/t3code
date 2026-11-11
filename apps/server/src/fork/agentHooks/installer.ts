import {
  errorLogPath,
  hookTitle,
  loadConfig,
  loadProjectConfig,
  resolveProgram,
} from "./hookRunner.ts";
import { describeKey, findProject, readTrustList } from "./projectHooks.ts";
import {
  type Agent,
  errorText,
  isMissingFile,
  isObject,
  type JsonObject,
  readTextIfPresent,
  type RunnerPaths,
  stringOr,
  userHookFile,
  writeFileAtomic,
} from "./shapes.ts";

const NodeFS = process.getBuiltinModule("node:fs");
const NodeOS = process.getBuiltinModule("node:os");
const NodePath = process.getBuiltinModule("node:path");

const SHIM_TIMEOUT_SECONDS = 600;

export interface Homes {
  readonly claude: string;
  readonly codex: string;
  readonly gemini: string;
  readonly runner: string;
  readonly runnerDir: string;
}

export const resolveHomes = (env: NodeJS.ProcessEnv): Homes => {
  // An empty variable counts as not set, so that no path is taken relative to the working folder.
  const home = env.HOME || NodeOS.homedir();
  return {
    claude: NodePath.join(home, ".claude"),
    codex: NodePath.join(home, ".codex"),
    gemini: NodePath.join(home, ".gemini"),
    runner: NodePath.join(home, ".agents", "bin", "agent-hooks"),
    runnerDir: NodePath.join(home, ".agents", "lib", "agent-hooks"),
  };
};

const withLinksResolved = (path: string): string => {
  try {
    return NodeFS.realpathSync(path);
  } catch (cause) {
    if (isMissingFile(cause)) return NodePath.resolve(path);
    throw cause;
  }
};

/** One note for each agent whose own variable names another config folder than the one install uses. */
export const otherFolderNotes = (env: NodeJS.ProcessEnv, homes: Homes): ReadonlyArray<string> => {
  const note = (variable: string, used: string, isUsed: (named: string) => boolean) => {
    const named = env[variable];
    return !named || isUsed(withLinksResolved(named))
      ? []
      : [
          `${variable} names ${named}: only ${used} is used, so an agent that starts with this variable does not run the hooks`,
        ];
  };
  return [
    ...note(
      "CLAUDE_CONFIG_DIR",
      homes.claude,
      (named) => named === withLinksResolved(homes.claude),
    ),
    // Codex resolves the links in CODEX_HOME before it builds the trust keys of its hook entries.
    ...note("CODEX_HOME", homes.codex, (named) => named === homes.codex),
  ];
};

const NATIVE_EVENTS: Readonly<Record<Agent, ReadonlyArray<string>>> = {
  claude: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
  codex: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
  agy: ["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse", "PostInvocation", "Stop"],
};
const AGY_TOOL_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse"]);
const SESSION_START_MATCHER = "startup|clear|compact";
const AGY_HOOK_NAME = "agent_hooks";

const SHELL_SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

export const shellQuote = (word: string): string =>
  SHELL_SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

// The agents hand the command to a shell. Entries written before the path was quoted hold the bare path.
const runnerWords = (homes: Homes): ReadonlyArray<string> => [
  ...new Set([shellQuote(homes.runner), homes.runner]),
];

const startsRunner = (command: unknown, homes: Homes, agent?: Agent): boolean =>
  typeof command === "string" &&
  runnerWords(homes).some((runner) =>
    command.startsWith(`${runner} run ${agent === undefined ? "" : `${agent} `}`),
  );

// Codex replaces a hook context above its own limit with a preview and a file path. The runner
// already cuts the context, so 0 turns that limit off on the events where the runner gives context.
const CODEX_CONTEXT_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
]);
const CODEX_NO_CONTEXT_LIMIT = 0;

const shimHandler = (runner: string, agent: Agent, nativeEvent: string): JsonObject => ({
  type: "command",
  command: `${runner} run ${agent} ${nativeEvent}`,
  timeout: SHIM_TIMEOUT_SECONDS,
  ...(agent === "codex" && CODEX_CONTEXT_EVENTS.has(nativeEvent)
    ? { additionalContextLimit: CODEX_NO_CONTEXT_LIMIT }
    : {}),
});

// Entries written before the context limit was set hold no such field.
const shimHandlerForms = (
  runner: string,
  agent: Agent,
  nativeEvent: string,
): ReadonlyArray<JsonObject> => {
  const { additionalContextLimit: _limit, ...withoutLimit } = shimHandler(
    runner,
    agent,
    nativeEvent,
  );
  return [shimHandler(runner, agent, nativeEvent), withoutLimit];
};

const shimGroup = (runner: string, agent: "claude" | "codex", nativeEvent: string): JsonObject => ({
  ...(nativeEvent === "SessionStart" ? { matcher: SESSION_START_MATCHER } : {}),
  hooks: [shimHandler(runner, agent, nativeEvent)],
});

export interface FileChange {
  readonly path: string;
  readonly kind: "write" | "symlink" | "remove";
  readonly content: string | null;
  readonly mode?: number;
  readonly why: string;
  readonly details?: ReadonlyArray<string>;
}

export interface InstallPlan {
  readonly changes: ReadonlyArray<FileChange>;
  readonly notes: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
}

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

interface JsonSpan {
  readonly start: number;
  readonly end: number;
  readonly members: ReadonlyArray<readonly [key: string | null, span: JsonSpan]>;
}

const jsonSpans = (text: string): JsonSpan => {
  let at = 0;
  const skipSpace = (): void => {
    while (at < text.length && " \t\r\n".includes(text.charAt(at))) at += 1;
  };
  const skipString = (): void => {
    at += 1;
    while (at < text.length && text.charAt(at) !== '"') at += text.charAt(at) === "\\" ? 2 : 1;
    at += 1;
  };
  const value = (): JsonSpan => {
    skipSpace();
    const start = at;
    const open = text.charAt(at);
    const members: Array<readonly [string | null, JsonSpan]> = [];
    if (open === "{" || open === "[") {
      at += 1;
      while (at < text.length) {
        skipSpace();
        const next = text.charAt(at);
        if (next === "}" || next === "]") break;
        if (next === ",") {
          at += 1;
          continue;
        }
        let key: string | null = null;
        if (open === "{") {
          const keyStart = at;
          skipString();
          key = stringOr(JSON.parse(text.slice(keyStart, at)), "");
          skipSpace();
          at += 1;
        }
        members.push([key, value()]);
      }
      at += 1;
    } else if (open === '"') {
      skipString();
    } else {
      while (at < text.length && !",]} \t\r\n".includes(text.charAt(at))) at += 1;
    }
    return { start, end: at, members };
  };
  return value();
};

const jsonLike = (
  value: unknown,
  span: JsonSpan | null,
  original: string,
  indent: string,
  depth: number,
): string => {
  if (span !== null) {
    const source = original.slice(span.start, span.end);
    if (sameJson(JSON.parse(source), value)) return source;
  }
  const lines = (open: string, close: string, items: ReadonlyArray<string>): string =>
    items.length === 0
      ? `${open}${close}`
      : `${open}\n${items.map((item) => `${indent.repeat(depth + 1)}${item}`).join(",\n")}\n${indent.repeat(depth)}${close}`;
  if (Array.isArray(value)) {
    const unused = [...(span?.members ?? [])];
    return lines(
      "[",
      "]",
      value.map((item: unknown) => {
        const index = unused.findIndex(([, member]) =>
          sameJson(JSON.parse(original.slice(member.start, member.end)), item),
        );
        const member = index < 0 ? null : (unused.splice(index, 1)[0]?.[1] ?? null);
        return jsonLike(item, member, original, indent, depth + 1);
      }),
    );
  }
  if (isObject(value)) {
    return lines(
      "{",
      "}",
      Object.entries(value).map(([key, item]) => {
        const member = span?.members.find(([name]) => name === key)?.[1] ?? null;
        return `${JSON.stringify(key)}: ${jsonLike(item, member, original, indent, depth + 1)}`;
      }),
    );
  }
  return JSON.stringify(value);
};

const jsonTextLike = (value: unknown, original: string | null): string => {
  if (original === null) return `${JSON.stringify(value, null, 2)}\n`;
  const indent = /^([ \t]+)\S/m.exec(original)?.[1] ?? "  ";
  const text = jsonLike(value, jsonSpans(original), original, indent, 0);
  return original.endsWith("\n") ? `${text}\n` : text;
};

const addedAndRemoved = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  ...before.filter((line) => !after.includes(line)).map((line) => `- ${line}`),
  ...after.filter((line) => !before.includes(line)).map((line) => `+ ${line}`),
];

const commandEntries = (
  value: unknown,
  path: ReadonlyArray<string> = [],
): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap((item) => commandEntries(item, path));
  if (!isObject(value)) return [];
  return [
    ...(typeof value.command === "string" ? [`${path.join(".")}: ${value.command}`] : []),
    ...Object.entries(value).flatMap(([key, item]) =>
      commandEntries(item, key === "hooks" ? path : [...path, key]),
    ),
  ];
};

const isOurHandler = (handler: unknown, homes: Homes, agent: Agent): boolean =>
  isObject(handler) && startsRunner(handler.command, homes, agent);

const withShimGroups = (
  events: JsonObject,
  homes: Homes,
  agent: "claude" | "codex",
  remove: boolean,
): JsonObject => {
  const next: JsonObject = {};
  for (const name of new Set([...Object.keys(events), ...NATIVE_EVENTS[agent]])) {
    const groups = events[name];
    const wanted =
      !remove && NATIVE_EVENTS[agent].includes(name)
        ? shimGroup(shellQuote(homes.runner), agent, name)
        : null;
    if (groups !== undefined && !Array.isArray(groups)) {
      if (wanted !== null) throw new Error(`"hooks.${name}" is not a list`);
      next[name] = groups;
      continue;
    }
    let present = false;
    const kept: Array<unknown> = [];
    for (const group of groups ?? []) {
      const handlers = isObject(group) && Array.isArray(group.hooks) ? group.hooks : null;
      if (handlers === null || !handlers.some((handler) => isOurHandler(handler, homes, agent))) {
        kept.push(group);
      } else if (wanted !== null && !present && sameJson(group, wanted)) {
        present = true;
        kept.push(group);
      } else {
        const foreign = handlers.filter((handler) => !isOurHandler(handler, homes, agent));
        if (foreign.length > 0) kept.push({ ...group, hooks: foreign });
      }
    }
    if (wanted !== null && !present) kept.push(wanted);
    if (kept.length > 0) next[name] = kept;
  }
  return next;
};

const snakeCase = (eventName: string): string =>
  eventName.replace(
    /[A-Z]/g,
    (letter, offset: number) => `${offset > 0 ? "_" : ""}${letter.toLowerCase()}`,
  );

const sortedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    isObject(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : 1)))
      : item,
  );

/** The hash Codex stores as `trusted_hash` for one command handler of a matcher group. */
export const codexTrustHash = (
  eventName: string,
  group: JsonObject,
  handler: JsonObject,
): string => {
  const NodeCrypto = process.getBuiltinModule("node:crypto");
  const identity = {
    event_name: snakeCase(eventName),
    ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
    hooks: [
      {
        type: "command",
        command: handler.command,
        timeout: handler.timeout ?? SHIM_TIMEOUT_SECONDS,
        async: handler.async ?? false,
        ...(handler.statusMessage === undefined ? {} : { statusMessage: handler.statusMessage }),
        ...(handler.additionalContextLimit === undefined
          ? {}
          : { additionalContextLimit: handler.additionalContextLimit }),
      },
    ],
  };
  return `sha256:${NodeCrypto.createHash("sha256").update(sortedJson(identity)).digest("hex")}`;
};

interface HandlerPosition {
  readonly key: string;
  readonly handler: unknown;
  readonly hash: string | null;
}

const codexHandlerPositions = (
  events: JsonObject,
  hooksFile: string,
  homes: Homes,
): ReadonlyArray<HandlerPosition> =>
  Object.entries(events).flatMap(([eventName, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group, groupIndex) =>
      (isObject(group) && Array.isArray(group.hooks) ? group.hooks : []).map(
        (handler, handlerIndex): HandlerPosition => ({
          key: `${hooksFile}:${snakeCase(eventName)}:${groupIndex}:${handlerIndex}`,
          handler,
          hash:
            isObject(group) && isObject(handler) && isOurHandler(handler, homes, "codex")
              ? codexTrustHash(eventName, group, handler)
              : null,
        }),
      ),
    ),
  );

const TOML_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\u001b",
  '"': '"',
  "\\": "\\",
};
const TOML_HEX_ESCAPES: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

interface TomlKeys {
  readonly keys: ReadonlyArray<string>;
  readonly end: number;
}

/** The dotted TOML key that starts at `start`, such as `a . "b c".'d'`, and the place after it. */
const tomlKeysAt = (line: string, start: number): TomlKeys | null => {
  let at = start;
  const skipSpace = (): void => {
    while (line.charAt(at) === " " || line.charAt(at) === "\t") at += 1;
  };
  const keys: Array<string> = [];
  for (;;) {
    skipSpace();
    const quote = line.charAt(at);
    if (quote === '"' || quote === "'") {
      at += 1;
      let key = "";
      while (at < line.length && line.charAt(at) !== quote) {
        if (quote === "'" || line.charAt(at) !== "\\") {
          key += line.charAt(at);
          at += 1;
          continue;
        }
        const escape = line.charAt(at + 1);
        const digits = TOML_HEX_ESCAPES[escape];
        if (digits === undefined) {
          const text = TOML_ESCAPES[escape];
          if (text === undefined) return null;
          key += text;
          at += 2;
          continue;
        }
        const hex = line.slice(at + 2, at + 2 + digits);
        const code = Number.parseInt(hex, 16);
        if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex) || code > 0x10ffff) return null;
        key += String.fromCodePoint(code);
        at += 2 + digits;
      }
      if (at >= line.length) return null;
      at += 1;
      keys.push(key);
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(line.slice(at))?.[0];
      if (bare === undefined) return null;
      keys.push(bare);
      at += bare.length;
    }
    skipSpace();
    if (line.charAt(at) !== ".") return { keys, end: at };
    at += 1;
  }
};

/** The keys of a TOML table header line such as `  [a."b c"] # note`, or null for any other line. */
export const tomlTableKeys = (line: string): ReadonlyArray<string> | null => {
  const open = /^[ \t]*\[(?!\[)/.exec(line);
  if (open === null) return null;
  const path = tomlKeysAt(line, open[0].length);
  if (path === null || !/^\][ \t]*(#.*)?\r?$/.test(line.slice(path.end))) return null;
  return path.keys;
};

interface TomlSegment {
  /** The keys of the table that the lines belong to: none before the first table, null for an array of tables. */
  readonly tableKeys: ReadonlyArray<string> | null;
  readonly stateKey: string | null;
  readonly lines: ReadonlyArray<string>;
}

const splitToml = (text: string): ReadonlyArray<TomlSegment> => {
  const segments: Array<{
    tableKeys: ReadonlyArray<string> | null;
    stateKey: string | null;
    lines: Array<string>;
  }> = [{ tableKeys: [], stateKey: null, lines: [] }];
  for (const line of text === "" ? [] : text.replace(/\n$/, "").split("\n")) {
    const tableKeys = tomlTableKeys(line);
    if (tableKeys !== null || /^[ \t]*\[\[/.test(line)) {
      const [first, second, third] = tableKeys ?? [];
      const isState = tableKeys?.length === 3 && first === "hooks" && second === "state";
      segments.push({ tableKeys, stateKey: isState ? (third ?? null) : null, lines: [] });
    }
    segments.at(-1)?.lines.push(line);
  }
  return segments;
};

/** Whether the text holds hook trust in another form than one `[hooks.state."<key>"]` table per entry. */
const hasOtherTrustForm = (text: string): boolean =>
  splitToml(text).some(
    (segment) =>
      segment.tableKeys !== null &&
      segment.tableKeys.length < 3 &&
      segment.lines.some((line) => {
        const path = tomlKeysAt(line, 0);
        if (path === null || line.charAt(path.end) !== "=") return false;
        const [first, second] = [...(segment.tableKeys ?? []), ...path.keys];
        return first === "hooks" && (second === undefined || second === "state");
      }),
  );

const trustTableHeaders = (text: string): ReadonlyArray<string> =>
  splitToml(text).flatMap((segment) => (segment.stateKey === null ? [] : [segment.lines[0] ?? ""]));

const trustTable = (key: string, hash: string): ReadonlyArray<string> => [
  `[hooks.state.${JSON.stringify(key)}]`,
  `trusted_hash = "${hash}"`,
  "enabled = true",
];

const withoutTrailingBlanks = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(0, end);
};

const withCodexTrust = (
  text: string,
  before: ReadonlyArray<HandlerPosition>,
  after: ReadonlyArray<HandlerPosition>,
  ourHashes: ReadonlySet<string>,
): string => {
  const moved = new Map<string, string>();
  for (const old of before) {
    if (old.hash !== null) continue;
    const now = after.find((position) => position.handler === old.handler);
    if (now !== undefined && now.key !== old.key) moved.set(old.key, now.key);
  }
  const wanted = new Map<string, string>();
  for (const position of after) {
    if (position.hash !== null) wanted.set(position.key, position.hash);
  }
  const placed = new Set<string>();
  const lines: Array<string> = [];
  let changed = false;
  for (const segment of splitToml(text)) {
    const key = segment.stateKey;
    const hash = /^\s*trusted_hash\s*=\s*(["'])(.*?)\1/m.exec(segment.lines.join("\n"))?.[2] ?? "";
    const target = key === null || ourHashes.has(hash) ? undefined : moved.get(key);
    const wantedHash = key === null || target !== undefined ? undefined : wanted.get(key);
    if (key === null) {
      lines.push(...segment.lines);
    } else if (target !== undefined) {
      lines.push(`[hooks.state.${JSON.stringify(target)}]`, ...segment.lines.slice(1));
      changed = true;
    } else if (wantedHash !== undefined && !placed.has(key)) {
      placed.add(key);
      const table = trustTable(key, wantedHash);
      const body = withoutTrailingBlanks(segment.lines);
      const values = (rows: ReadonlyArray<string>) => rows.slice(1).map((row) => row.trim());
      if (sameJson(values(body), values(table))) {
        lines.push(...segment.lines);
      } else {
        lines.push(...table, ...segment.lines.slice(body.length));
        changed = true;
      }
    } else if (wantedHash !== undefined || ourHashes.has(hash)) {
      changed = true;
    } else {
      lines.push(...segment.lines);
    }
  }
  const result = [...withoutTrailingBlanks(lines)];
  for (const [key, hash] of wanted) {
    if (placed.has(key)) continue;
    if (result.length > 0) result.push("");
    result.push(...trustTable(key, hash));
    changed = true;
  }
  if (!changed) return text;
  return result.length > 0 ? `${result.join("\n")}\n` : "";
};

const agyShims = (homes: Homes): JsonObject =>
  Object.fromEntries(
    NATIVE_EVENTS.agy.map((nativeEvent) => {
      const handler = shimHandler(shellQuote(homes.runner), "agy", nativeEvent);
      return [
        nativeEvent,
        AGY_TOOL_EVENTS.has(nativeEvent) ? [{ matcher: "*", hooks: [handler] }] : [handler],
      ];
    }),
  );

const SHEBANG = "#!/usr/bin/env node\n";
const ENTRY_MODULE = "agentHooks.mjs";

/**
 * The installed runner as one `.mjs` text per module of this folder. Made from the `.ts` sources,
 * the types are removed and the imports name the `.mjs` files; an installed copy is taken as it is.
 */
export const installedRunnerFiles = (moduleDir: string): ReadonlyMap<string, string> => {
  const names = NodeFS.readdirSync(moduleDir).sort();
  const read = (name: string): string =>
    NodeFS.readFileSync(NodePath.join(moduleDir, name), "utf8");
  const installed = names.filter((name) => name.endsWith(".mjs"));
  if (installed.length > 0) return new Map(installed.map((name) => [name, read(name)]));
  const NodeModule = process.getBuiltinModule("node:module");
  return new Map(
    names
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => {
        const moduleName = `${name.slice(0, -".ts".length)}.mjs`;
        const code = NodeModule.stripTypeScriptTypes(read(name)).replace(
          /"(\.\/\w+)\.ts"/g,
          '"$1.mjs"',
        );
        return [moduleName, moduleName === ENTRY_MODULE ? SHEBANG + code : code];
      }),
  );
};

const parseJsonObject = (text: string | null): JsonObject | null => {
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error("the file does not hold a JSON object");
  return parsed;
};

const readJsonObject = (path: string): JsonObject | null =>
  parseJsonObject(readTextIfPresent(path));

const currentLinkTarget = (path: string): string | null => {
  try {
    return NodeFS.readlinkSync(path);
  } catch {
    return null;
  }
};

const isPresent = (path: string): boolean =>
  NodeFS.lstatSync(path, { throwIfNoEntry: false }) !== undefined;

const commandsIn = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap(commandsIn);
  if (!isObject(value)) return [];
  return [
    ...(typeof value.command === "string" ? [value.command] : []),
    ...Object.values(value).flatMap(commandsIn),
  ];
};

const installedModuleNames = (runnerDir: string): ReadonlyArray<string> => {
  try {
    return NodeFS.readdirSync(runnerDir).filter((name) => name.endsWith(".mjs"));
  } catch (cause) {
    if (isMissingFile(cause)) return [];
    throw cause;
  }
};

/** Every file change that brings the disk to the installed state, or with `remove` takes our part out again. */
export const planInstall = (
  homes: Homes,
  runnerFiles: ReadonlyMap<string, string>,
  remove = false,
): InstallPlan => {
  const changes: Array<FileChange> = [];
  const notes: Array<string> = [];
  const problems: Array<string> = [];
  const verb = remove ? "remove" : "add";

  const editJsonFile = (
    file: string,
    label: string,
    edit: (current: JsonObject) => JsonObject,
  ): { readonly before: JsonObject; readonly after: JsonObject } | null => {
    try {
      const text = readTextIfPresent(file);
      const before = parseJsonObject(text) ?? {};
      const after = edit(before);
      if (!sameJson(before, after)) {
        changes.push({
          path: file,
          kind: "write",
          content: jsonTextLike(after, text),
          why: `${verb} the ${label} hook entries`,
          details: addedAndRemoved(commandEntries(before), commandEntries(after)),
        });
      }
      return { before, after };
    } catch (cause) {
      problems.push(`${file}: ${errorText(cause)}`);
      return null;
    }
  };

  const editEventLists =
    (agent: "claude" | "codex") =>
    (current: JsonObject): JsonObject => {
      if (current.hooks !== undefined && !isObject(current.hooks)) {
        throw new Error('"hooks" is not an object');
      }
      const events = withShimGroups(current.hooks ?? {}, homes, agent, remove);
      if (Object.keys(events).length > 0) return { ...current, hooks: events };
      const { hooks: _hooks, ...rest } = current;
      return rest;
    };

  if (NodeFS.existsSync(homes.claude)) {
    editJsonFile(NodePath.join(homes.claude, "settings.json"), "Claude", editEventLists("claude"));
  } else {
    notes.push(`Claude: skipped, ${homes.claude} does not exist`);
  }

  if (NodeFS.existsSync(homes.codex)) {
    const hooksFile = NodePath.join(homes.codex, "hooks.json");
    const configFile = NodePath.join(homes.codex, "config.toml");
    const edited = editJsonFile(hooksFile, "Codex", editEventLists("codex"));
    if (edited !== null) {
      const positions = (file: JsonObject): ReadonlyArray<HandlerPosition> =>
        codexHandlerPositions(isObject(file.hooks) ? file.hooks : {}, hooksFile, homes);
      const ourHashes = new Set(
        runnerWords(homes).flatMap((runner) =>
          NATIVE_EVENTS.codex.flatMap((nativeEvent) =>
            shimHandlerForms(runner, "codex", nativeEvent).map((handler) =>
              codexTrustHash(nativeEvent, shimGroup(runner, "codex", nativeEvent), handler),
            ),
          ),
        ),
      );
      const configText = readTextIfPresent(configFile) ?? "";
      if (!remove && hasOtherTrustForm(configText)) {
        problems.push(
          `${configFile}: it keeps hook trust outside [hooks.state."<key>"] tables, a form that install cannot edit`,
        );
      }
      const nextConfig = withCodexTrust(
        configText,
        positions(edited.before),
        positions(edited.after),
        ourHashes,
      );
      if (nextConfig !== configText) {
        changes.push({
          path: configFile,
          kind: "write",
          content: nextConfig,
          why: remove
            ? "remove the Codex trust tables of the hook entries"
            : "trust the Codex hook entries",
          details: addedAndRemoved(trustTableHeaders(configText), trustTableHeaders(nextConfig)),
        });
      }
    }
  } else {
    notes.push(`Codex: skipped, ${homes.codex} does not exist`);
  }

  if (NodeFS.existsSync(homes.gemini)) {
    const shims = agyShims(homes);
    editJsonFile(NodePath.join(homes.gemini, "config", "hooks.json"), "Antigravity", (current) => {
      const { [AGY_HOOK_NAME]: group, ...rest } = current;
      if (group === undefined) return remove ? current : { ...current, [AGY_HOOK_NAME]: shims };
      const commands = commandsIn(group);
      const ours = commands.filter((command) => startsRunner(command, homes, "agy")).length;
      if (ours === 0 && remove) return current;
      if (ours === 0 || ours < commands.length) {
        throw new Error(
          `the hook named "${AGY_HOOK_NAME}" holds entries that install did not write; give them another name`,
        );
      }
      return remove ? rest : { ...rest, [AGY_HOOK_NAME]: shims };
    });
  } else {
    notes.push(`Antigravity: skipped, ${homes.gemini} does not exist`);
  }

  const runnerChanges: Array<FileChange> = [];
  // An absolute target also holds when the folder of the link is itself a link to another place.
  const linkTarget = NodePath.join(homes.runnerDir, ENTRY_MODULE);
  const hasOurLink = currentLinkTarget(homes.runner) === linkTarget;
  const removeModule = (name: string): FileChange => ({
    path: NodePath.join(homes.runnerDir, name),
    kind: "remove",
    content: null,
    why: "remove a runner module",
  });
  if (!remove) {
    for (const [name, content] of runnerFiles) {
      const path = NodePath.join(homes.runnerDir, name);
      if (readTextIfPresent(path) === content) continue;
      runnerChanges.push({
        path,
        kind: "write",
        content,
        ...(name === ENTRY_MODULE ? { mode: 0o755 } : {}),
        why: "install a runner module",
      });
    }
    runnerChanges.push(
      ...installedModuleNames(homes.runnerDir)
        .filter((name) => !runnerFiles.has(name))
        .map(removeModule),
    );
    if (!hasOurLink) {
      if (isPresent(homes.runner)) {
        problems.push(`${homes.runner} exists and is not the link that install makes`);
      } else {
        runnerChanges.push({
          path: homes.runner,
          kind: "symlink",
          content: linkTarget,
          why: "link the runner command",
        });
      }
    }
  } else {
    if (hasOurLink) {
      runnerChanges.push({
        path: homes.runner,
        kind: "remove",
        content: null,
        why: "remove the runner command",
      });
    }
    runnerChanges.push(...installedModuleNames(homes.runnerDir).map(removeModule));
  }

  // The runner goes in before any entry names it and comes out after the last entry is gone.
  return {
    changes: remove ? [...changes, ...runnerChanges] : [...runnerChanges, ...changes],
    notes,
    problems,
  };
};

export const applyChanges = (changes: ReadonlyArray<FileChange>): void => {
  for (const change of changes) {
    if (change.kind === "remove") {
      NodeFS.rmSync(change.path, { force: true });
      continue;
    }
    NodeFS.mkdirSync(NodePath.dirname(change.path), { recursive: true });
    if (change.kind === "symlink") {
      NodeFS.rmSync(change.path, { force: true });
      NodeFS.symlinkSync(change.content ?? "", change.path);
      continue;
    }
    let target = change.path;
    let mode = change.mode;
    try {
      target = NodeFS.realpathSync(change.path);
      mode ??= NodeFS.statSync(target).mode & 0o777;
    } catch (cause) {
      if (!isMissingFile(cause)) throw cause;
    }
    writeFileAtomic(target, change.content ?? "", mode);
    if (mode !== undefined) NodeFS.chmodSync(target, mode);
  }
};

export const describeChange = (change: FileChange): string =>
  [
    `${change.kind} ${change.path}: ${change.why}`,
    ...(change.kind === "symlink" ? [`-> ${change.content}`] : (change.details ?? [])).map(
      (line) => `  ${line}`,
    ),
  ].join("\n");

export interface Finding {
  readonly level: "ok" | "warn" | "error";
  readonly text: string;
}

const NATIVE_HOOK_FILES = (
  homes: Homes,
): ReadonlyArray<{ readonly agent: Agent; readonly file: string }> => [
  { agent: "claude", file: NodePath.join(homes.claude, "settings.json") },
  { agent: "codex", file: NodePath.join(homes.codex, "hooks.json") },
  { agent: "agy", file: NodePath.join(homes.gemini, "config", "hooks.json") },
];

/** The oldest Node that runs the `.ts` entry of a checkout and the installed runner, as `major.minor`. */
export const MIN_NODE_VERSION = "22.18";

const isExecutableFile = (path: string): boolean => {
  try {
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Checks the install without a model call. */
export const doctor = (
  homes: Homes,
  paths: RunnerPaths,
  runnerFiles: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv,
  cwd: string,
): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = [];
  const plan = planInstall(homes, runnerFiles);
  for (const problem of plan.problems) findings.push({ level: "error", text: problem });
  for (const change of plan.changes) {
    findings.push({
      level: "warn",
      text: `not installed: ${change.path} (${change.why}); run "agent-hooks install"`,
    });
  }
  if (plan.changes.length === 0 && plan.problems.length === 0) {
    findings.push({ level: "ok", text: "the runner and the agent hook entries are installed" });
  }
  for (const note of plan.notes) findings.push({ level: "ok", text: note });
  for (const note of otherFolderNotes(env, homes)) findings.push({ level: "warn", text: note });

  const NodeChildProcess = process.getBuiltinModule("node:child_process");
  const node = NodeChildProcess.spawnSync("node", ["--version"], { encoding: "utf8", env });
  const [, major, minor] = (/^v(\d+)\.(\d+)/.exec(node.stdout ?? "") ?? []).map(Number);
  const [minMajor = 0, minMinor = 0] = MIN_NODE_VERSION.split(".").map(Number);
  if (node.status !== 0 || major === undefined || minor === undefined) {
    findings.push({
      level: "error",
      text: "`node` is not on PATH, so the agents cannot start the runner",
    });
  } else if (major < minMajor || (major === minMajor && minor < minMinor)) {
    findings.push({
      level: "error",
      text: `the node on PATH is ${node.stdout.trim()}; the runner needs Node ${MIN_NODE_VERSION} or newer`,
    });
  }

  const config = loadConfig(paths);
  for (const problem of config.problems) findings.push({ level: "error", text: problem });
  findings.push({
    level: "ok",
    text: `${config.hooks.length} hook(s) in ${userHookFile(paths)}`,
  });
  try {
    readTrustList(paths);
  } catch (cause) {
    findings.push({ level: "error", text: `no project is trusted: ${errorText(cause)}` });
  }
  const project = findProject(cwd, paths);
  const projectConfig = loadProjectConfig(project, paths);
  if (project === null) {
    findings.push({ level: "ok", text: `no project hook file at or above ${cwd}` });
  } else if (project.trusted && project.key !== null) {
    findings.push({
      level: "ok",
      text: `${projectConfig.hooks.length} project hook(s) in ${project.file}, trusted through ${describeKey(project.key)}`,
    });
  } else if (project.key === null) {
    findings.push({
      level: "warn",
      text: `the project hook file ${project.file} cannot be trusted, so its hooks do not run: ${project.folder} or its .git entry cannot be read`,
    });
  } else {
    findings.push({
      level: "warn",
      text: `the project hook file ${project.file} is not trusted, so its hooks do not run; to trust it, run "agent-hooks trust ${shellQuote(project.folder)}"`,
    });
  }
  for (const problem of projectConfig.problems) findings.push({ level: "error", text: problem });
  const pathFolders = new Set(
    (env.PATH ?? "").split(NodePath.delimiter).filter((folder) => folder !== ""),
  );
  const nativeCommands = NATIVE_HOOK_FILES(homes).flatMap(({ agent, file }) => {
    try {
      return commandsIn(readJsonObject(file)).map((command) => ({ agent, file, command }));
    } catch {
      return [];
    }
  });
  for (const spec of [...config.hooks, ...projectConfig.hooks]) {
    const hook = hookTitle(spec.name, spec.project);
    const program = resolveProgram(spec.command[0] ?? "", spec.dir);
    if (NodePath.isAbsolute(program)) {
      if (!isExecutableFile(program)) {
        findings.push({
          level: "error",
          text: `${hook}: ${program} is missing or not executable`,
        });
      }
    } else if (
      ![...pathFolders].some((folder) => isExecutableFile(NodePath.join(folder, program)))
    ) {
      findings.push({
        level: "error",
        text: `${hook}: ${program} is not next to hooks.json and not on PATH`,
      });
    }
    const scripts = [program, ...spec.command.slice(1)].filter(
      (part) => NodePath.isAbsolute(part) && !pathFolders.has(NodePath.dirname(part)),
    );
    const twice = nativeCommands.find(
      ({ agent, command }) =>
        spec.agents.has(agent) &&
        !startsRunner(command, homes) &&
        scripts.some((script) => command.includes(script)),
    );
    if (twice !== undefined) {
      findings.push({
        level: "warn",
        text: `${hook} is also wired in ${twice.file}, so it runs twice there`,
      });
    }
  }

  const errors = (readTextIfPresent(errorLogPath(paths)) ?? "")
    .trim()
    .split("\n")
    .filter((line) => line !== "");
  for (const line of errors.slice(-5))
    findings.push({ level: "warn", text: `recent error: ${line}` });
  return findings;
};
