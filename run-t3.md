# Run the embedded chat

`chat-t3/` is a copy of T3 Code with the whiteboard's embedding changes. The whiteboard's chat panel is an iframe that shows it. The copy keeps its state under `~/.whiteboard/t3-userdata` and reads nothing from a personal T3 installation (`~/.t3`, port 3773, the `t3code` service).

Browsers reach it only through the whiteboard's `webPort`. The whiteboard proxies `/chat/` on `webPort` to `chatPort`, along with the chat's own `/api`, `/ws`, and `/.well-known` paths, so `chatPort` stays bound to `127.0.0.1` and is never exposed. This copy accepts every browser without pairing, so expose `webPort` only to people who may use the chat.

## Install and build

Run once, and again after changing anything under `apps/web`. The server serves the built output. The build is configured for the `/chat/` prefix, so its pages load only through the whiteboard's `webPort`; opening `chatPort` straight in a browser fails to fetch the assets.

```bash
cd chat-t3
pnpm install
# T3's prepare script points this repository's git hooks at chat-t3, which
# breaks committing anywhere in the whiteboard. Undo it right after installing.
git config --unset core.hooksPath
pnpm --dir apps/web run build
cd ..
```

## Run as a systemd user service

`run-t3.sh` starts the copy it sits in. Three environment variables override its defaults: `T3_PORT` (default `6070`, must equal `chatPort` in `~/.whiteboard/config.json`), `T3_DATA` (default `~/.whiteboard/t3-userdata`), and `T3_PROJECT` (default the repository root, the project the chat opens in).

Save this as `~/.config/systemd/user/wb-t3.service`, with `WorkingDirectory` set to the repository root:

```ini
[Unit]
Description=Whiteboard embedded T3 Code

[Service]
WorkingDirectory=/path/to/whiteboard
ExecStart=/usr/bin/env bash chat-t3/run-t3.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Then enable it. `enable-linger` keeps user services running after you log out.

```bash
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now wb-t3
```

Restart after a rebuild with `systemctl --user restart wb-t3`; read its log with `journalctl --user -u wb-t3 -f`.

## Embedding changes to T3 Code

This copy differs from upstream T3 Code in the points below. Keep this list current when porting the copy to a newer upstream.

- No login. Requests without a credential, or with a rejected one, get a full-scope session (`unsafe-no-auth`) instead of a 401; websocket tickets issued to that session are accepted. Files: `apps/server/src/auth/EnvironmentAuth.ts` (with `EnvironmentAuth.test.ts`, `apps/server/src/server.test.ts` adjusted to match).
- Whiteboard skills for agents. `T3CODE_CLAUDE_PLUGIN_ROOT` is loaded as a local Claude plugin; `T3CODE_CODEX_SKILL_ROOT` is registered with each Codex app-server through `skills/extraRoots/set`. Files: `apps/server/src/provider/Layers/ClaudeAdapter.ts`, `codexLaunchArgs.ts` (`resolveCodexSkillRoot`), `CodexProvider.ts`, `CodexSessionRuntime.ts`. `run-t3.sh` sets both variables, puts `tools/bin` on `PATH`, and sets `BASH_ENV` to `tools/agent-env.sh`.
- Served under `/chat/`. Files: `apps/web/vite.config.ts` (`base: "/chat/"`), `apps/web/src/router.ts` (`basepath: "/chat"`).
- Whiteboard links. `board://` links in assistant markdown are allowed, rendered with hover and click messages to the parent window (`wb-hover`, `wb-highlight`), and `[label](board://...)` mention chips in the composer show the label and report hover. Files: `apps/web/src/markdown-whiteboard.ts` (with test), `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/components/ComposerPromptEditorTiptap.tsx`, `packages/shared/src/composerInlineTokens.ts` (board mention token).
- Parent-window messages. The chat posts `wb-project` (workspace root and thread key) when the active thread changes, and inserts a reference into the composer on a `wb-insert-ref` message. The composer never switches to its mobile layout inside the iframe. Files: `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/ChatComposer.tsx`.
- Iframe layout. The sidebar starts closed and the provider-update launch notification is not rendered. Files: `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/routes/__root.tsx`.
- New-thread landing. `run-t3.sh` sets `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false` so each page load opens the new-thread page rather than the oldest thread of the project.
