# Agent hooks

A hook is a script that an agent runs at a fixed point of its work, such as before a tool call. Claude Code, Codex and the Antigravity CLI (`agy`) each have their own hook file, input and output. Agent hooks gives you one format for all three. You write a hook script once and wire it once.

The same hooks run in T3 Code threads, in the threads that agents start through T3 Code, and when you start an agent from your own terminal. In each case the agent reads the hook file in its default config folder. An agent that is set up with another config folder does not run them; see [Limits](#limits).

Agent hooks runs on Linux and macOS and needs Node 22.18 or newer on your `PATH`.

## Install

Run this once from a checkout of this fork:

```bash
node apps/server/src/fork/agentHooks/agentHooks.ts install --dry-run   # prints every change, writes nothing
node apps/server/src/fork/agentHooks/agentHooks.ts install
~/.agents/bin/agent-hooks doctor
```

`install` copies a small program, the runner, to `~/.agents/lib/agent-hooks` and links it at `~/.agents/bin/agent-hooks`. It then adds entries that start the runner to each agent's own hook file:

| Agent       | File                                             | Entries                                                                 |
| ----------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| Claude Code | `~/.claude/settings.json`                        | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` |
| Codex       | `~/.codex/hooks.json` and `~/.codex/config.toml` | The same five, plus the trust table Codex needs for each                |
| Antigravity | `~/.gemini/config/hooks.json`                    | One hook named `agent_hooks` with all six Antigravity events            |

Every entry and setting that is already in these files stays. A second `install` changes nothing. An agent whose config folder does not exist is skipped.

`install`, `doctor` and `uninstall` always work on these three config folders, `~/.claude`, `~/.codex` and `~/.gemini`. They take no folder argument and do not read `CLAUDE_CONFIG_DIR` or `CODEX_HOME` to pick a folder. When one of the two variables names another folder, each command says so.

`uninstall` removes exactly these entries, the trust tables of the Codex entries, the runner's files and its link. A file that `install` made stays, with no entries in it, and the folders stay. A Codex entry that stood after the runner's entry moves up one place, so `uninstall` gives its trust table the new position.

`install` stops and writes nothing in these cases. Correct the file and run `install` again.

- The Antigravity file already has a hook named `agent_hooks` that holds an entry `install` did not write. Give those entries another name. `uninstall` stops in the same way when that hook holds both its entries and others.
- `~/.agents/bin/agent-hooks` exists and is not the link that `install` makes. Move that file. `uninstall` leaves such a file in place.
- `~/.codex/config.toml` keeps hook trust in another form than one `[hooks.state."<key>"]` table per entry, such as an inline table. Codex itself writes one table per entry.
- One of the three hook files is not a JSON object, the `hooks` value of the Claude Code or Codex file is not an object, or one of the five events in it is not a list. `uninstall` stops too in the first two cases.

You do not touch these files again. To add or change a hook, edit your hook file. The next hook call uses it, with no reinstall and no new Codex trust.

## The hook file

Your hooks live in `~/.agents/hooks/hooks.json`. Put your scripts next to it. To keep the file and the scripts in another folder, set `AGENT_HOOKS_DIR` to that folder's absolute path in the environment of the agents and of `doctor`.

```json
{
  "version": 1,
  "hooks": {
    "house_rules": {
      "events": ["SessionStart", "PostCompact"],
      "command": ["house_rules.sh"]
    },
    "no_force_push": {
      "events": ["PreTool"],
      "tools": ["shell"],
      "command": ["no_force_push.py"]
    },
    "file_size": {
      "events": ["PostTool"],
      "tools": ["edit"],
      "command": ["file_size.py", "--max-kb", "20"],
      "agents": ["claude", "codex"],
      "timeout": 20
    }
  }
}
```

| Field     | Meaning                                                                                                                                                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name      | The key, such as `no_force_push`. It appears in the error log. It must not be a number.                                                                                                                                                                                                                                     |
| `events`  | One or more of `SessionStart`, `PromptSubmit`, `PreTool`, `PostTool`, `Stop`, `PostCompact`.                                                                                                                                                                                                                                |
| `tools`   | Only for `PreTool` and `PostTool`. Tool classes: `shell`, `edit`, `read`, `search`, `mcp`, `agent`, `other`. Left out means all.                                                                                                                                                                                            |
| `command` | The program and its arguments, as a list. No shell runs it. A program name without a folder part is looked up next to `hooks.json`, then on `PATH`. A relative path with a folder part, such as `checks/size.py`, is looked up only next to `hooks.json`. A leading `~/` in the program or an argument is your home folder. |
| `agents`  | Optional. Some of `claude`, `codex`, `agy`. Left out means all three.                                                                                                                                                                                                                                                       |
| `timeout` | Seconds. Default 10, at most 590.                                                                                                                                                                                                                                                                                           |
| `enabled` | Optional. `false` turns the hook off.                                                                                                                                                                                                                                                                                       |

The hooks of one event run at the same time. Their answers are merged in file order. One Antigravity call can carry `PostCompact` and `PromptSubmit` together. The hooks of both events then run at the same time, and the `PostCompact` text comes first.

## Events

| Event          | When it fires                                                     | What the hook can do                                               |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `SessionStart` | A new conversation starts or is cleared. Not when one is resumed. | Give text to the model before its first call.                      |
| `PromptSubmit` | You send a prompt.                                                | Give text to the model with this prompt, or refuse the prompt.     |
| `PreTool`      | Before a tool call runs.                                          | Refuse the call. The model reads the reason.                       |
| `PostTool`     | After a tool call that succeeded.                                 | Give text to the model in the same turn, before its next call.     |
| `Stop`         | The agent is about to end its turn.                               | Make the agent go on. The model reads the reason.                  |
| `PostCompact`  | The conversation was compacted (summarized to save context).      | Give text to the model before its first call after the compaction. |

## What a hook script reads

The script gets one JSON object on stdin. It has every field the agent itself sent, except the tool's result on `PostTool`, plus these fields, which mean the same on all three agents:

| Field                    | Events                    | Meaning                                                                                               |
| ------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `event`                  | all                       | The event name from the table above.                                                                  |
| `hook_event_name`        | all                       | The name Claude Code uses: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` or `Stop`. |
| `agent`                  | all                       | `claude`, `codex` or `agy`.                                                                           |
| `session_id`             | all                       | The agent's id of the conversation.                                                                   |
| `cwd`                    | all                       | The agent's working folder. The script also starts there.                                             |
| `transcript_path`        | all                       | The agent's transcript file, or `null`. Its format belongs to the agent.                              |
| `source`                 | SessionStart, PostCompact | `startup` or `clear` for SessionStart, `compact` for PostCompact.                                     |
| `prompt`                 | PromptSubmit              | The prompt text.                                                                                      |
| `tool_class`             | PreTool, PostTool         | `shell`, `edit`, `read`, `search`, `mcp`, `agent` or `other`.                                         |
| `tool_name`              | PreTool, PostTool         | `Bash` for a shell call on every agent. Otherwise the agent's own tool name.                          |
| `tool_input`             | PreTool, PostTool         | The agent's arguments. A shell call always has `command`.                                             |
| `file_paths`             | PreTool, PostTool         | Absolute paths of the files the call names. For a Codex patch, every file in the patch.               |
| `tool_use_id`            | PreTool, PostTool         | The id of the call.                                                                                   |
| `last_assistant_message` | Stop                      | The model's last reply.                                                                               |
| `stop_hook_active`       | Stop                      | `true` when a Stop hook already made the agent go on in this turn. Use it to avoid a loop.            |
| `native`                 | all                       | The agent's own payload, unchanged.                                                                   |

A hook that should work on every agent tests `tool_class`, `tool_input.command` and `file_paths`, not tool names. A script written for Claude Code's `PreToolUse`, `PostToolUse`, `Stop` or `SessionStart` reads the same field names here, with one exception: `PostTool` has no `tool_response` field, because Antigravity does not give the tool's result to a hook. On Claude Code and Codex the result is at `native.tool_response`.

## What a hook script answers

| The script                                                  | Meaning                      |
| ----------------------------------------------------------- | ---------------------------- |
| exits 0 and prints nothing                                  | No decision.                 |
| exits 2 with a reason on stderr                             | Block, with that reason.     |
| exits 0 and prints `{"decision": "block", "reason": "..."}` | Block.                       |
| exits 0 and prints `{"context": "..."}`                     | Give this text to the model. |

Claude Code's own shapes work too: `hookSpecificOutput.additionalContext` is context, and `hookSpecificOutput.permissionDecision: "deny"` with `permissionDecisionReason` is a block.

A block refuses the prompt on `PromptSubmit`, refuses the call on `PreTool`, and makes the agent go on at `Stop`. On `PostTool` a block is given to the model as context, because the tool already ran. `SessionStart` and `PostCompact` cannot block, and `PreTool` and `Stop` cannot add context. When several hooks answer, any block wins and the reasons are joined; context texts are joined and cut at 8,000 characters.

A hook cannot approve a tool call, rewrite its input or ask you a question, because not all three agents can do that. Keep such a hook in the agent's own hook file.

## When a hook fails

A hook fails when it crashes, runs past its timeout, exits with a code other than 0 or 2, prints text that is not the JSON above, or gives an answer its event does not allow. A failed hook counts as no decision: the prompt, tool call or turn end goes ahead, and the other hooks of the event still count. The rule is the same on all three agents.

Each failure adds one line to `~/.local/state/agent-hooks/errors.jsonl`, or to `$XDG_STATE_HOME/agent-hooks/errors.jsonl` when that variable is set. `agent-hooks doctor` prints the last five. It also reports entries that are not installed, a Node on `PATH` that is missing or too old, a bad entry in `hooks.json`, a program that is missing or not executable where the runner looks for it, and a script that is wired both here and in an agent's own hook file, where it would run twice. It makes no model call.

To see every hook call with its input and answer, set `AGENT_HOOKS_TRACE=<file>` in the environment of the agent.

## Limits

- **Antigravity, automatic compaction.** Antigravity compacts after it has run the hook that comes before a model call. So after an automatic compaction the `PostCompact` text reaches the model one call late: at its next call in the same turn, or with your next prompt. After a manual `/compact` it arrives before the first call.
- **Antigravity in T3 Code.** Agent hooks supports the hook engine of the `agy` program. Set the Antigravity provider's binary path to `agy`, so that T3 Code runs it as `agy acp`. The Antigravity server program that T3 Code installs by default has a different hook engine and is not supported.
- **Generated text.** T3 Code writes titles, commit messages and other generated text in helper runs of an agent. No hook runs there, because a hook could refuse the helper's prompt or change its text. T3 Code starts the Claude Code helper and the Codex helper with all hooks off, also the hooks in the agent's own hook file. A `codex exec` or `claude -p` that you start yourself runs the hooks as usual.
- **Antigravity, generated text.** After `install`, `~/.gemini/config` holds hooks. T3 Code then does not use the Antigravity CLI for generated text, because the hooks would run in those helper sessions too. Select another model for generated text. See [Antigravity](./providers-antigravity.md#use-the-antigravity-cli).
- **Codex trust.** Codex runs a hook entry only at the position it trusted. If you add an entry to `~/.codex/hooks.json` above the runner's entry, run `install` again. `doctor` reports this case.
- **Other config folders.** Only the three default config folders get the entries. A Claude Code that starts with `CLAUDE_CONFIG_DIR`, or a Codex that starts with `CODEX_HOME`, set to another folder does not run the hooks. This includes a T3 Code provider instance that is set up with its own home folder.
