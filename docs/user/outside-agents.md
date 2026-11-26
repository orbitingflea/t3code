# Outside agents

Connect external agents (Claude Code or Codex in your terminal, ChatGPT, or any OAuth-capable MCP client) to your T3 Code environment over MCP to read projects/threads, launch and message threads, and monitor events.

## Quick setup

Open the command palette (`Cmd/Ctrl+K`) and run **Use T3 Code in another app (MCP)** (or open **Settings → Sharing & access**), pick your app, and follow the prompts.

- Cloud assistants (like ChatGPT or Claude) require **T3 Connect** enabled on the environment.
- To also reach other machines through the same connection, enable **Settings → Labs → Linked environments** and [link them](./remote-access.md#link-another-environment).
- To copy the raw MCP endpoint (`https://<environment-address>/mcp`), open an environment's menu in **Settings → Environments → Copy MCP URL**. OAuth requires `https://` or `localhost` (plain `http://` LAN/Tailscale addresses cannot complete OAuth).

### CLI clients and ChatGPT

- **Claude Code**:
  ```sh
  claude mcp add --transport http t3 https://<environment-address>/mcp
  claude mcp login t3   # add --no-browser on headless hosts
  ```
- **Codex**:
  ```sh
  codex mcp add t3 --url https://<environment-address>/mcp
  codex mcp login t3    # add --no-browser on headless hosts
  ```
- **ChatGPT / other OAuth MCP clients**: Add a custom remote MCP server pointing to `https://<environment-address>/mcp` with **OAuth** authentication (no client ID or secret needed).

## Approve access and permissions

The first time an outside agent connects, approve its sign-in page (via your T3 Connect account, an already-authorized browser, or a one-time pairing code from **Settings → Sharing & access** / `t3 auth pairing create`).

- **Read only**: Inspect projects, threads, providers, and models.
- **Supervised → Full access**: Also launch, message, and stop threads up to the granted permission mode. Managing [workflow runs](./workflows.md) or using approval-skipping agent modes requires **Full access** (or your policy's maximum mode).
- Sign-ins last **30 days**; revoke anytime in **Settings → Sharing & access**.

## Available tools and limits

Tools that act as a running T3 thread (`delegate_task`, `create_threads`, `request_secret`, `html_render`, `preview_*`, `device_*`, `t3_worktree_handoff`) only work for agents running **inside** T3 Code.

- Use `t3_thread_launch` + `t3_thread_wait` / `t3_thread_read` to run and follow work.
- Pass `projectId` or `threadId` explicitly (or `allProjects: true` on `t3_thread_list`).
- **MCP Events (`io.modelcontextprotocol/events`)**: Bots can poll, stream, or subscribe via HTTPS webhooks (up to 1-hour leases; latest 1,000 milestones buffered in memory) for turn, approval, guest, PR watch, and workflow events. For local webhook testing, set `T3CODE_MCP_WEBHOOK_ALLOWED_HOSTS=localhost,127.0.0.1` on the server.

## Host scripts (`t3 thread`)

On the server machine itself, drive threads directly without OAuth:

```sh
id=$(t3 thread start . "Find why the tests are slow")
t3 thread send "$id" "Now fix it" --wait
t3 thread show "$id"
t3 thread user-view "$id" --sub-thread 51c0de
t3 thread list
```

<<<<<<< origin/main
`.` means the project that contains the current folder, or a git worktree of
its repository; a project id also works. A new thread uses the project's
default model and permission mode, and runs in the project folder unless you
pass `--worktree <base-branch>`. Its title is the message's first line, or
`--title`; add `--generate-title` to have it named from the message, as threads
started in the app are. `send` never interrupts: a busy thread gets the message
as its next turn. Pass `-` as the message to read it from stdin.

To choose the model, pass `--provider <instance-id> --model <slug>`. Add
`--option id=value` for each model option. For reasoning effort, Codex uses
`--option reasoningEffort=high`, while Claude uses `--option effort=high`.
Option ids and allowed values depend on the provider and model; use those
reported by `orchestrator_capabilities`. `true` and `false` set on/off options.

`user-view` prints a Chat mode thread word for word as your screen shows it: the latest main-list messages, or
with `--sub-thread`, a sub-thread and the three main-list messages before it.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id.

## Remove an agent

Approved agents appear under **Settings → Sharing & access** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.
=======
- Pass `--worktree <base-branch>`, `--title` / `--generate-title`, `--provider <id> --model <slug>`, `--option id=value` (e.g. `reasoningEffort=high` for Codex, `effort=high` for Claude), or `-` to read the prompt from stdin.
- `--wait` prints the reply and exits `1` on failure/stop or `2` when waiting for user input. Add `--json` for structured output including the thread ID.
>>>>>>> upstream/main
