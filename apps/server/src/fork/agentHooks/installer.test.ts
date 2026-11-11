import { describe, expect, it } from "vite-plus/test";

import { main } from "./agentHooks.ts";
import recorded from "./fixtures/recordedPayloads.json" with { type: "json" };
import {
  applyChanges,
  codexTrustHash,
  doctor,
  installedRunnerFiles,
  MIN_NODE_VERSION,
  otherFolderNotes,
  planInstall,
  resolveHomes,
  tomlTableKeys,
} from "./installer.ts";
import { runnerPaths } from "./shapes.ts";

const NodeChildProcess = process.getBuiltinModule("node:child_process");
const NodeFS = process.getBuiltinModule("node:fs");
const NodeOS = process.getBuiltinModule("node:os");
const NodePath = process.getBuiltinModule("node:path");

const runnerFiles = installedRunnerFiles(import.meta.dirname);

const foreignHandler = (command: string) => ({ type: "command", command, timeout: 10 });

const CLAUDE_SETTINGS = {
  model: "some-model",
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [foreignHandler("/opt/guards/no_force_push.py")] },
      { matcher: "Write|Edit", hooks: [foreignHandler("/opt/guards/size.py")] },
    ],
    PermissionRequest: [{ matcher: "*", hooks: [foreignHandler("/opt/guards/deny.py")] }],
  },
  permissions: { allow: ["Bash(ls:*)"] },
};

const CODEX_HOOKS = {
  description: "my hooks",
  hooks: {
    PreToolUse: [
      { matcher: "^Bash$", hooks: [foreignHandler("/opt/guards/no_force_push.py")] },
      { matcher: "^apply_patch$", hooks: [foreignHandler("/opt/guards/size.py")] },
    ],
    Stop: [{ hooks: [foreignHandler("/opt/guards/short_reply.py")] }],
  },
};

const AGY_HANDLER_LINE = '{"type": "command", "command": "/opt/guards/agy.py"}';

const AGY_HOOKS_TEXT = `{
  "my_rules": {
    "PreToolUse": [
      {
        "matcher": "run_command",
        "hooks": [
          ${AGY_HANDLER_LINE}
        ]
      }
    ],
    "Stop": [
      {"type": "command", "command": "/opt/guards/agy_stop.py"}
    ]
  }
}
`;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const makeHome = (prefix = "agent-hooks-home-") => {
  const home = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  const files = {
    claude: NodePath.join(home, ".claude", "settings.json"),
    codexHooks: NodePath.join(home, ".codex", "hooks.json"),
    codexConfig: NodePath.join(home, ".codex", "config.toml"),
    agy: NodePath.join(home, ".gemini", "config", "hooks.json"),
  };
  const stateKey = (suffix: string) => `[hooks.state."${files.codexHooks}:${suffix}"]`;
  const codexConfig = [
    'model = "some-model"',
    "",
    '[projects."/work/project"]',
    'trust_level = "trusted"',
    "",
    stateKey("pre_tool_use:0:0"),
    'trusted_hash = "sha256:aaaa"',
    "enabled = true",
    "",
    stateKey("pre_tool_use:1:0"),
    'trusted_hash = "sha256:bbbb"',
    "enabled = true",
    "",
    stateKey("stop:0:0"),
    'trusted_hash = "sha256:cccc"',
    "enabled = true",
    "",
    "[mcp_servers.docs]",
    'command = "docs-server"',
    "",
  ].join("\n");
  for (const [file, content] of [
    [files.claude, json(CLAUDE_SETTINGS)],
    [files.codexHooks, json(CODEX_HOOKS)],
    [files.codexConfig, codexConfig],
    [files.agy, AGY_HOOKS_TEXT],
  ] as const) {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, content);
  }
  const env = { HOME: home, PATH: process.env.PATH ?? "" };
  const homes = resolveHomes(env);
  const read = (file: string) => NodeFS.readFileSync(file, "utf8");
  return {
    home,
    files,
    env,
    homes,
    read,
    readJson: (file: string) => JSON.parse(read(file)),
    snapshot: () => Object.values(files).map(read),
    stateKey,
    install: () => applyChanges(planInstall(homes, runnerFiles).changes),
    uninstall: () => applyChanges(planInstall(homes, runnerFiles, true).changes),
  };
};

const commands = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap(commands);
  if (typeof value !== "object" || value === null) return [];
  return [
    ...("command" in value && typeof value.command === "string" ? [value.command] : []),
    ...Object.values(value).flatMap(commands),
  ];
};

describe("install", () => {
  it("appends its entries, keeps every other entry, and changes nothing on a second run", () => {
    const sandbox = makeHome();
    const runner = NodePath.join(sandbox.home, ".agents", "bin", "agent-hooks");

    sandbox.install();

    const claude = sandbox.readJson(sandbox.files.claude);
    expect({ ...claude, hooks: undefined }).toEqual({ ...CLAUDE_SETTINGS, hooks: undefined });
    expect(claude.hooks.PermissionRequest).toEqual(CLAUDE_SETTINGS.hooks.PermissionRequest);
    expect(claude.hooks.PreToolUse).toEqual([
      ...CLAUDE_SETTINGS.hooks.PreToolUse,
      { hooks: [{ type: "command", command: `${runner} run claude PreToolUse`, timeout: 600 }] },
    ]);
    expect(claude.hooks.SessionStart).toEqual([
      {
        matcher: "startup|clear|compact",
        hooks: [{ type: "command", command: `${runner} run claude SessionStart`, timeout: 600 }],
      },
    ]);
    expect(Object.keys(claude.hooks).sort()).toEqual([
      "PermissionRequest",
      "PostToolUse",
      "PreToolUse",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);

    const codex = sandbox.readJson(sandbox.files.codexHooks);
    expect(codex.description).toBe("my hooks");
    expect(commands(codex.hooks.PreToolUse)).toEqual([
      "/opt/guards/no_force_push.py",
      "/opt/guards/size.py",
      `${runner} run codex PreToolUse`,
    ]);

    const agy = sandbox.readJson(sandbox.files.agy);
    expect(agy.my_rules).toEqual(JSON.parse(AGY_HOOKS_TEXT).my_rules);
    expect(sandbox.read(sandbox.files.agy)).toContain(`\n          ${AGY_HANDLER_LINE}\n`);
    expect(Object.keys(agy.agent_hooks)).toEqual([
      "SessionStart",
      "PreInvocation",
      "PreToolUse",
      "PostToolUse",
      "PostInvocation",
      "Stop",
    ]);
    expect(agy.agent_hooks.PreToolUse).toEqual([
      {
        matcher: "*",
        hooks: [{ type: "command", command: `${runner} run agy PreToolUse`, timeout: 600 }],
      },
    ]);
    expect(agy.agent_hooks.Stop).toEqual([
      { type: "command", command: `${runner} run agy Stop`, timeout: 600 },
    ]);

    expect(NodeFS.readlinkSync(runner)).toBe(
      NodePath.join(sandbox.home, ".agents", "lib", "agent-hooks", "agentHooks.mjs"),
    );
    const installed = sandbox.snapshot();
    expect(planInstall(sandbox.homes, runnerFiles)).toEqual({
      changes: [],
      notes: [],
      problems: [],
    });
    sandbox.install();
    expect(sandbox.snapshot()).toEqual(installed);
  });

  it("trusts its Codex entries at the keys Codex uses, next to the tables of other entries", () => {
    const sandbox = makeHome();

    sandbox.install();

    const config = sandbox.read(sandbox.files.codexConfig);
    const group = (nativeEvent: string) =>
      sandbox.readJson(sandbox.files.codexHooks).hooks[nativeEvent].at(-1);
    const table = (suffix: string, nativeEvent: string) =>
      [
        sandbox.stateKey(suffix),
        `trusted_hash = "${codexTrustHash(nativeEvent, group(nativeEvent), group(nativeEvent).hooks[0])}"`,
        "enabled = true",
      ].join("\n");
    for (const [suffix, nativeEvent] of [
      ["pre_tool_use:2:0", "PreToolUse"],
      ["stop:1:0", "Stop"],
      ["session_start:0:0", "SessionStart"],
      ["user_prompt_submit:0:0", "UserPromptSubmit"],
      ["post_tool_use:0:0", "PostToolUse"],
    ] as const) {
      expect(config).toContain(table(suffix, nativeEvent));
    }
    expect(config).toContain('trusted_hash = "sha256:aaaa"');
    expect(config).toContain('[mcp_servers.docs]\ncommand = "docs-server"');
  });

  // The expected values are what Codex 0.167 reports as `currentHash` for these entries in `hooks/list`.
  it.each([
    [
      "SessionStart",
      "startup|clear|compact",
      "098059d359294bb2cf58053316011961468c0566af58be82d175d96d8dfd418f",
    ],
    [
      "UserPromptSubmit",
      undefined,
      "b169e4d7d6d8d4894739832b4d6f93ae9ffb32c53edbc742c7b3b159707050ce",
    ],
    ["PreToolUse", undefined, "5fc89eb1c9a78441a7b4704fab56a3bc7dec3cd7ac1a370ebbbb0996ee6ed50c"],
    ["PostToolUse", undefined, "1efa8d64a72244ff294019d66573103c014795a95412caea57ca02a22eac3ec7"],
    ["Stop", undefined, "33fbe23232a6a6e56792bc62fce969b2b51a44197c7166359dc335eb87528a9d"],
  ] as const)("computes the trust hash Codex computes for %s", (nativeEvent, matcher, hash) => {
    const handler = {
      type: "command",
      command: `/home/user/.agents/bin/agent-hooks run codex ${nativeEvent}`,
      timeout: 600,
    };
    const group = { ...(matcher === undefined ? {} : { matcher }), hooks: [handler] };

    expect(codexTrustHash(nativeEvent, group, handler)).toBe(`sha256:${hash}`);
  });

  it("uses one config folder per agent and names a variable that points an agent at another", async () => {
    const sandbox = makeHome();
    const other = NodePath.join(sandbox.home, "other");
    const link = NodePath.join(sandbox.home, "codex-link");
    NodeFS.symlinkSync(NodePath.join(sandbox.home, ".codex"), link);
    const elsewhere = { ...sandbox.env, CLAUDE_CONFIG_DIR: other, CODEX_HOME: other };

    expect(resolveHomes(elsewhere)).toEqual(sandbox.homes);
    expect(otherFolderNotes(elsewhere, sandbox.homes)).toEqual([
      `CLAUDE_CONFIG_DIR names ${other}: only ${sandbox.home}/.claude is used, so an agent that starts with this variable does not run the hooks`,
      `CODEX_HOME names ${other}: only ${sandbox.home}/.codex is used, so an agent that starts with this variable does not run the hooks`,
    ]);
    expect(
      doctor(sandbox.homes, runnerPaths(elsewhere), runnerFiles, elsewhere).filter((finding) =>
        finding.text.startsWith("C"),
      ),
    ).toEqual(otherFolderNotes(elsewhere, sandbox.homes).map((text) => ({ level: "warn", text })));
    const printed: Array<string> = [];
    expect(await main(["install", "--dry-run"], elsewhere, (text) => printed.push(text))).toBe(0);
    expect(printed.slice(0, 2)).toEqual(
      otherFolderNotes(elsewhere, sandbox.homes).map((text) => `${text}\n`),
    );
    // Codex resolves a link in CODEX_HOME, so a link to the folder in use is the same folder.
    expect(
      otherFolderNotes(
        {
          ...sandbox.env,
          CLAUDE_CONFIG_DIR: `${sandbox.home}/.claude/`,
          CODEX_HOME: link,
        },
        sandbox.homes,
      ),
    ).toEqual([]);
  });

  it("takes an empty variable as not set", () => {
    const sandbox = makeHome();
    const empty = {
      CODEX_HOME: "",
      CLAUDE_CONFIG_DIR: "",
      AGENT_HOOKS_DIR: "",
      XDG_STATE_HOME: "",
    };

    expect(otherFolderNotes({ ...sandbox.env, ...empty }, sandbox.homes)).toEqual([]);
    expect(runnerPaths({ ...sandbox.env, ...empty })).toEqual(runnerPaths(sandbox.env));
  });

  it("moves its trust table when another entry is put before it", () => {
    const sandbox = makeHome();
    sandbox.install();
    const codex = sandbox.readJson(sandbox.files.codexHooks);
    codex.hooks.Stop.unshift({ hooks: [foreignHandler("/opt/guards/new_first.py")] });
    NodeFS.writeFileSync(sandbox.files.codexHooks, json(codex));

    sandbox.install();

    const config = sandbox.read(sandbox.files.codexConfig);
    const ourHash = codexTrustHash("Stop", codex.hooks.Stop[2], codex.hooks.Stop[2].hooks[0]);
    expect(config).toContain(`${sandbox.stateKey("stop:2:0")}\ntrusted_hash = "${ourHash}"`);
    expect(config).not.toContain(`${sandbox.stateKey("stop:1:0")}\ntrusted_hash = "${ourHash}"`);
    expect(config.split(ourHash)).toHaveLength(2);
  });

  it.each([
    ["indentation and a comment", (key: string) => `  [hooks.state.${key}]  # trusted by hand`],
    ["spaces inside the brackets", (key: string) => `[ hooks . state . ${key} ]`],
    ["quoted table names", (key: string) => `["hooks".'state'.${key}]`],
    ["a literal key", (key: string) => `[hooks.state.'${JSON.parse(key)}']`],
    ["an escaped key", (key: string) => `[hooks.state.${key.replace("/", "\\u002F")}]`],
  ] as const)("knows its trust tables when their headers have %s", (_form, header) => {
    const sandbox = makeHome();
    const reformat = (config: string) =>
      config
        .split("\n")
        .map((line) => {
          const key = /^\[hooks\.state\.(".*")\]$/.exec(line)?.[1];
          return key === undefined
            ? line.replace(/^(trusted_hash|enabled) /, "  $1 ")
            : header(key);
        })
        .join("\n");
    const start = reformat(sandbox.read(sandbox.files.codexConfig));
    sandbox.install();
    const installed = reformat(sandbox.read(sandbox.files.codexConfig));
    expect(installed.split("[").length).toBe(start.split("[").length + 5);
    NodeFS.writeFileSync(sandbox.files.codexConfig, installed);

    expect(planInstall(sandbox.homes, runnerFiles).changes).toEqual([]);

    sandbox.uninstall();
    expect(sandbox.read(sandbox.files.codexConfig)).toBe(start);
  });

  it.each([
    ["[a.\"b c\".'d.e']", ["a", "b c", "d.e"]],
    ['\t[ "tab\\t\\u0041\\U0001F600" ]\t# note', ["tab\tA\u{1F600}"]],
    ["['C:\\dir']\r", ["C:\\dir"]],
    ["[[a]]", null],
    ["[a] b", null],
    ['["a]', null],
    ['["\\q"]', null],
    ["[a.]", null],
    ['["x", "y"],', null],
    ["a = [1]", null],
  ] as const)("reads the table header %j as %j", (line, keys) => {
    expect(tomlTableKeys(line)).toEqual(keys);
  });

  it.each([
    '[hooks.state]\n"/some/hooks.json:stop:0:0" = { trusted_hash = "sha256:eeee", enabled = true }\n',
    "[hooks]\nstate = {}\n",
    'hooks = { state = {} }\n\n[projects."/work/project"]\ntrust_level = "trusted"\n',
    'hooks.state."/some/hooks.json:stop:0:0".enabled = true\n',
  ])(
    "stops when the Codex config keeps hook trust in a form it cannot edit: %j",
    async (config) => {
      const sandbox = makeHome();
      NodeFS.writeFileSync(sandbox.files.codexConfig, config);
      const start = sandbox.snapshot();

      expect(planInstall(sandbox.homes, runnerFiles).problems).toEqual([
        `${sandbox.files.codexConfig}: it keeps hook trust outside [hooks.state."<key>"] tables, a form that install cannot edit`,
      ]);
      expect(await main(["install"], sandbox.env, () => undefined)).toBe(1);
      expect(sandbox.snapshot()).toEqual(start);
      expect(planInstall(sandbox.homes, runnerFiles, true).problems).toEqual([]);
    },
  );

  it("installs next to hook settings of Codex that are not trust", () => {
    const sandbox = makeHome();
    NodeFS.writeFileSync(
      sandbox.files.codexConfig,
      "[features]\nhooks = true\n\n[hooks]\nnotify = true\n\n[hooks.state]\n",
    );

    expect(planInstall(sandbox.homes, runnerFiles).problems).toEqual([]);
  });

  it("skips an agent that has no config folder", () => {
    const sandbox = makeHome();
    NodeFS.rmSync(NodePath.join(sandbox.home, ".codex"), { recursive: true });
    NodeFS.rmSync(NodePath.join(sandbox.home, ".gemini"), { recursive: true });

    const plan = planInstall(sandbox.homes, runnerFiles);

    expect(plan.notes).toEqual([
      `Codex: skipped, ${sandbox.home}/.codex does not exist`,
      `Antigravity: skipped, ${sandbox.home}/.gemini does not exist`,
    ]);
    expect(plan.changes.map((change) => NodePath.basename(change.path))).toEqual([
      "agentAdapters.mjs",
      "agentHooks.mjs",
      "hookRunner.mjs",
      "installer.mjs",
      "shapes.mjs",
      "agent-hooks",
      "settings.json",
    ]);
  });

  it("writes commands that a shell runs from a home folder with spaces and quotes", () => {
    const sandbox = makeHome("agent hooks' $HOME-");

    sandbox.install();

    const command = sandbox.readJson(sandbox.files.claude).hooks.Stop.at(-1).hooks[0].command;
    const run = NodeChildProcess.spawnSync("/bin/sh", ["-c", command], {
      input: JSON.stringify(recorded.claude.stop),
      env: sandbox.env,
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(planInstall(sandbox.homes, runnerFiles).changes).toEqual([]);
  });

  it("refuses an Antigravity hook named agent_hooks that it did not write", async () => {
    const sandbox = makeHome();
    const mine = { Stop: [foreignHandler("/opt/guards/mine.py")] };
    NodeFS.writeFileSync(sandbox.files.agy, json({ agent_hooks: mine }));
    const start = sandbox.snapshot();

    const plan = planInstall(sandbox.homes, runnerFiles);

    expect(plan.problems).toEqual([
      `${sandbox.files.agy}: the hook named "agent_hooks" holds entries that install did not write; give them another name`,
    ]);
    expect(await main(["install"], sandbox.env, () => undefined)).toBe(1);
    expect(NodeFS.existsSync(NodePath.join(sandbox.home, ".agents"))).toBe(false);
    sandbox.uninstall();
    expect(sandbox.snapshot()).toEqual(start);
  });

  it("refuses to take apart an agent_hooks hook that also holds an entry it did not write", async () => {
    const sandbox = makeHome();
    sandbox.install();
    const agy = sandbox.readJson(sandbox.files.agy);
    agy.agent_hooks.Stop.push(foreignHandler("/opt/guards/mine.py"));
    NodeFS.writeFileSync(sandbox.files.agy, json(agy));
    const mixed = sandbox.snapshot();
    const problems = [
      `${sandbox.files.agy}: the hook named "agent_hooks" holds entries that install did not write; give them another name`,
    ];

    expect(planInstall(sandbox.homes, runnerFiles).problems).toEqual(problems);
    expect(planInstall(sandbox.homes, runnerFiles, true).problems).toEqual(problems);
    expect(await main(["uninstall"], sandbox.env, () => undefined)).toBe(1);
    expect(sandbox.snapshot()).toEqual(mixed);
    expect(NodeFS.existsSync(sandbox.homes.runner)).toBe(true);
  });

  it("refuses an event of Claude or Codex whose value is not a list", async () => {
    const sandbox = makeHome();
    NodeFS.writeFileSync(sandbox.files.claude, json({ hooks: { Stop: {}, Notification: {} } }));
    const start = sandbox.snapshot();

    expect(planInstall(sandbox.homes, runnerFiles).problems).toEqual([
      `${sandbox.files.claude}: "hooks.Stop" is not a list`,
    ]);
    expect(await main(["install"], sandbox.env, () => undefined)).toBe(1);
    expect(sandbox.snapshot()).toEqual(start);
    expect(planInstall(sandbox.homes, runnerFiles, true)).toEqual({
      changes: [],
      notes: [],
      problems: [],
    });
  });

  it("refuses a runner command that is not its own link", () => {
    const sandbox = makeHome();
    NodeFS.mkdirSync(NodePath.dirname(sandbox.homes.runner), { recursive: true });
    NodeFS.symlinkSync("/opt/tools/agent-hooks", sandbox.homes.runner);

    expect(planInstall(sandbox.homes, runnerFiles).problems).toEqual([
      `${sandbox.homes.runner} exists and is not the link that install makes`,
    ]);
    sandbox.uninstall();
    expect(NodeFS.readlinkSync(sandbox.homes.runner)).toBe("/opt/tools/agent-hooks");
  });

  it("writes through a config file that is a link and refuses a file it cannot parse", () => {
    const sandbox = makeHome();
    const real = NodePath.join(sandbox.home, "dotfiles-settings.json");
    NodeFS.renameSync(sandbox.files.claude, real);
    NodeFS.symlinkSync(real, sandbox.files.claude);
    NodeFS.writeFileSync(sandbox.files.agy, "{ not json");

    const plan = planInstall(sandbox.homes, runnerFiles);
    applyChanges(plan.changes);

    expect(NodeFS.lstatSync(sandbox.files.claude).isSymbolicLink()).toBe(true);
    expect(commands(JSON.parse(NodeFS.readFileSync(real, "utf8")))).toHaveLength(8);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]).toContain(sandbox.files.agy);
    expect(sandbox.read(sandbox.files.agy)).toBe("{ not json");
  });

  it("installs a runner that answers a hook call as its own process", () => {
    const sandbox = makeHome();
    sandbox.install();
    const hooksDir = NodePath.join(sandbox.home, ".agents", "hooks");
    NodeFS.mkdirSync(hooksDir);
    NodeFS.writeFileSync(
      NodePath.join(hooksDir, "refuse.sh"),
      "#!/bin/sh\necho refused >&2\nexit 2\n",
      {
        mode: 0o755,
      },
    );
    NodeFS.writeFileSync(
      NodePath.join(hooksDir, "hooks.json"),
      json({
        hooks: { refuse: { events: ["PreTool"], tools: ["shell"], command: ["refuse.sh"] } },
      }),
    );

    const run = NodeChildProcess.spawnSync(
      process.execPath,
      [sandbox.homes.runner, "run", "agy", "PreToolUse"],
      { input: JSON.stringify(recorded.agy.preToolUseShell), env: sandbox.env, encoding: "utf8" },
    );

    expect(run.stderr).toBe("");
    expect(run.stdout).toBe('{"decision":"deny","reason":"refused"}');
    expect(run.status).toBe(0);
  });

  it("installs a copy that can check and reinstall itself, also below a folder that is a link", () => {
    const sandbox = makeHome();
    const dotfiles = NodePath.join(sandbox.home, "dotfiles", "deep", "bin");
    NodeFS.mkdirSync(dotfiles, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(sandbox.home, ".agents"));
    NodeFS.symlinkSync(dotfiles, NodePath.join(sandbox.home, ".agents", "bin"));
    sandbox.install();
    const command = (...args: ReadonlyArray<string>) =>
      NodeChildProcess.spawnSync(process.execPath, [sandbox.homes.runner, ...args], {
        env: sandbox.env,
        encoding: "utf8",
      });

    expect(command("install", "--dry-run").stdout).toBe("Nothing to change.\n");
    expect(command("doctor").stdout).toBe(
      `ok    the runner and the agent hook entries are installed\nok    0 hook(s) in ${sandbox.home}/.agents/hooks/hooks.json\n`,
    );
  });
});

describe("the install command", () => {
  it("prints every planned change on a dry run and writes nothing", async () => {
    const sandbox = makeHome();
    const start = sandbox.snapshot();
    const runner = sandbox.homes.runner;
    const printed: Array<string> = [];

    const exitCode = await main(["install", "--dry-run"], sandbox.env, (text) => {
      printed.push(text);
    });

    const output = printed.join("");
    expect(exitCode).toBe(0);
    expect(sandbox.snapshot()).toEqual(start);
    expect(NodeFS.existsSync(NodePath.join(sandbox.home, ".agents"))).toBe(false);
    expect(output).toContain(
      `write ${sandbox.files.claude}: add the Claude hook entries\n  + PreToolUse: ${runner} run claude PreToolUse\n`,
    );
    expect(output).toContain(`  + ${sandbox.stateKey("pre_tool_use:2:0")}\n`);
    expect(output).toContain(`  + agent_hooks.Stop: ${runner} run agy Stop\n`);
    expect(output).toContain(`symlink ${runner}: link the runner command\n`);
    expect(output.endsWith("Dry run: nothing was written.\n")).toBe(true);

    expect(await main(["install"], sandbox.env, () => undefined)).toBe(0);
    expect(planInstall(sandbox.homes, runnerFiles).changes).toEqual([]);
  });

  it.each([
    ["install", "--dryrun"],
    ["uninstall", "/some/folder"],
    ["doctor", "--dry-run"],
    ["status", "--dry-run"],
  ])("refuses %s %s and writes nothing", async (command, argument) => {
    const sandbox = makeHome();
    sandbox.install();
    const installed = sandbox.snapshot();
    const printed: Array<string> = [];

    expect(await main([command, argument], sandbox.env, (text) => printed.push(text))).toBe(1);

    expect(printed.join("")).toContain("Usage: agent-hooks <command>");
    expect(sandbox.snapshot()).toEqual(installed);
    expect(NodeFS.existsSync(sandbox.homes.runner)).toBe(true);
  });
});

describe("uninstall", () => {
  it("restores the starting files and removes the runner", () => {
    const sandbox = makeHome();
    const start = sandbox.snapshot();
    sandbox.install();

    sandbox.uninstall();

    expect(sandbox.snapshot()).toEqual(start);
    expect(NodeFS.readdirSync(NodePath.join(sandbox.home, ".agents", "bin"))).toEqual([]);
    expect(NodeFS.readdirSync(sandbox.homes.runnerDir)).toEqual([]);
    expect(planInstall(sandbox.homes, runnerFiles, true).changes).toEqual([]);
  });

  it("replaces and removes entries that hold the runner path without quotes", () => {
    const sandbox = makeHome("agent hooks home-");
    const start = sandbox.snapshot();
    const runner = sandbox.homes.runner;
    const hookFiles = [sandbox.files.claude, sandbox.files.codexHooks, sandbox.files.agy];
    const takeQuotesOut = () => {
      const quoted = sandbox.readJson(sandbox.files.codexHooks).hooks;
      for (const file of hookFiles) {
        NodeFS.writeFileSync(file, sandbox.read(file).replaceAll(`'${runner}'`, runner));
      }
      const bare = sandbox.readJson(sandbox.files.codexHooks).hooks;
      let config = sandbox.read(sandbox.files.codexConfig);
      for (const nativeEvent of Object.keys(quoted)) {
        const [before, after] = [quoted[nativeEvent].at(-1), bare[nativeEvent].at(-1)];
        config = config.replace(
          codexTrustHash(nativeEvent, before, before.hooks[0]),
          codexTrustHash(nativeEvent, after, after.hooks[0]),
        );
      }
      NodeFS.writeFileSync(sandbox.files.codexConfig, config);
    };
    sandbox.install();
    const installed = sandbox.snapshot();
    takeQuotesOut();
    expect(sandbox.snapshot().join("")).not.toContain(`'${runner}'`);

    sandbox.install();
    expect(sandbox.snapshot()).toEqual(installed);

    takeQuotesOut();
    sandbox.uninstall();
    expect(sandbox.snapshot()).toEqual(start);
  });

  it("leaves an empty file where install made the file", () => {
    const sandbox = makeHome();
    for (const file of Object.values(sandbox.files)) NodeFS.rmSync(file);
    sandbox.install();

    sandbox.uninstall();

    expect(sandbox.snapshot()).toEqual(["{}\n", "{}\n", "", "{}\n"]);
  });

  it("keeps the trust of an entry that stood after ours", () => {
    const sandbox = makeHome();
    sandbox.install();
    const codex = sandbox.readJson(sandbox.files.codexHooks);
    codex.hooks.Stop.push({ hooks: [foreignHandler("/opt/guards/added_later.py")] });
    NodeFS.writeFileSync(sandbox.files.codexHooks, json(codex));
    NodeFS.appendFileSync(
      sandbox.files.codexConfig,
      `\n${sandbox.stateKey("stop:2:0")}\ntrusted_hash = "sha256:dddd"\nenabled = true\n`,
    );

    sandbox.uninstall();

    expect(commands(sandbox.readJson(sandbox.files.codexHooks).hooks.Stop)).toEqual([
      "/opt/guards/short_reply.py",
      "/opt/guards/added_later.py",
    ]);
    const config = sandbox.read(sandbox.files.codexConfig);
    expect(config).toContain(`${sandbox.stateKey("stop:1:0")}\ntrusted_hash = "sha256:dddd"`);
    expect(config).not.toContain(sandbox.stateKey("stop:2:0"));
  });
});

describe("doctor", () => {
  const levels = (sandbox: ReturnType<typeof makeHome>) =>
    doctor(sandbox.homes, runnerPaths(sandbox.env), runnerFiles, sandbox.env);

  it("reports what is not installed, and then a clean install", () => {
    const sandbox = makeHome();

    expect(levels(sandbox).filter((finding) => finding.level === "warn")).toHaveLength(10);
    sandbox.install();

    expect(levels(sandbox)).toEqual([
      { level: "ok", text: "the runner and the agent hook entries are installed" },
      { level: "ok", text: `0 hook(s) in ${sandbox.home}/.agents/hooks/hooks.json` },
    ]);
  });

  it.each([
    ["v22.17.1", 1],
    ["v22.18.0", 0],
    ["v24.0.0", 0],
  ])("takes node %s on PATH as too old %i time(s)", (version, count) => {
    const sandbox = makeHome();
    sandbox.install();
    const bin = NodePath.join(sandbox.home, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(NodePath.join(bin, "node"), `#!/bin/sh\necho ${version}\n`, {
      mode: 0o755,
    });
    const env = { ...sandbox.env, PATH: bin };

    expect(
      doctor(sandbox.homes, runnerPaths(env), runnerFiles, env).filter(
        (finding) => finding.level === "error",
      ),
    ).toEqual(
      Array.from({ length: count }, () => ({
        level: "error",
        text: `the node on PATH is ${version}; the runner needs Node ${MIN_NODE_VERSION} or newer`,
      })),
    );
    const guide = NodePath.join(import.meta.dirname, "../../../../../docs/user/agent-hooks.md");
    expect(NodeFS.readFileSync(guide, "utf8")).toContain(`needs Node ${MIN_NODE_VERSION} or newer`);
  });

  it("reports a bad hook entry, a missing script, a script wired twice, and recent errors", () => {
    const sandbox = makeHome();
    sandbox.install();
    const hooksDir = NodePath.join(sandbox.home, ".agents", "hooks");
    NodeFS.mkdirSync(hooksDir);
    NodeFS.writeFileSync(
      NodePath.join(hooksDir, "hooks.json"),
      json({
        hooks: {
          bad: { events: ["Sometimes"], command: ["x"] },
          twice: { events: ["PreTool"], command: ["/opt/guards/size.py", "--max", "20"] },
          elsewhere: {
            events: ["PreTool"],
            command: ["/opt/guards/size.py", "--max", "20"],
            agents: ["agy"],
          },
          absent: { events: ["Stop"], command: ["house_rules.sh"] },
          below: { events: ["Stop"], command: ["scripts/house_rules.sh"] },
          onPath: { events: ["Stop"], command: ["sh"] },
        },
      }),
    );
    const errorLog = NodePath.join(sandbox.home, ".local", "state", "agent-hooks", "errors.jsonl");
    NodeFS.mkdirSync(NodePath.dirname(errorLog), { recursive: true });
    NodeFS.writeFileSync(errorLog, '{"hook":"twice","problem":"could not start"}\n');

    expect(levels(sandbox).filter((finding) => finding.level !== "ok")).toEqual([
      { level: "error", text: 'hook "bad": "events" has the unknown value "Sometimes"' },
      { level: "error", text: 'hook "twice": /opt/guards/size.py is missing or not executable' },
      {
        level: "warn",
        text: `hook "twice" is also wired in ${sandbox.files.claude}, so it runs twice there`,
      },
      {
        level: "error",
        text: 'hook "elsewhere": /opt/guards/size.py is missing or not executable',
      },
      {
        level: "error",
        text: 'hook "absent": house_rules.sh is not next to hooks.json and not on PATH',
      },
      {
        level: "error",
        text: `hook "below": ${hooksDir}/scripts/house_rules.sh is missing or not executable`,
      },
      { level: "warn", text: 'recent error: {"hook":"twice","problem":"could not start"}' },
    ]);
  });
});
