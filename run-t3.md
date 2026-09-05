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
