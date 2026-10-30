# Whiteboard

A research whiteboard: a tldraw canvas with a side-panel agent chat that supports both Claude Code and Codex, built with a minimum of custom code.

## Configuration

The services read `~/.whiteboard/config.json` when it exists. Every field is optional:

```json
{
  "dataDir": "/path/to/data",
  "host": "127.0.0.1",
  "port": 6060,
  "webPort": 6061,
  "chatPort": 6070,
  "allowedHosts": [".ts.net", "board.example.com"],
  "openViews": { "board.example.com": "board" }
}
```

- `dataDir` — directory holding room snapshots (default `~/.whiteboard/data`).
- `host` — address the sync server binds (default `127.0.0.1`).
- `port` — sync server port (default `6060`). The Vite proxy reads this value when it starts, so restart the dev server after changing it.
- `webPort` — port the web page itself is served on (default `6061`). This is the address users open in the browser.
- `chatPort` — port the embedded chat is served on (default `6070`). The Vite proxy reads this value when it starts, so restart the dev server after changing it.
- `allowedHosts` — hostnames the web server accepts in the `Host` header (default none, so only `localhost` works). List every hostname a reverse proxy or Tailscale Serve uses to reach the page; a leading dot matches all subdomains. The web server reads this value when it starts, so restart it after changing it.
- `openViews` — hostnames that open the page with only one side shown, mapped to `"board"` or `"chat"` (default none). The page on such a hostname starts in that view on every load; the buttons still switch to the other side or the split. Other hostnames reopen the layout last used there. The web server reads this value when it starts, so restart it after changing it.

## Project rooms

The default room is `main`; clients connect at `/connect/<room>`, read with `GET /api/board?room=<room>`, and write with `POST /api/board/edit?room=<room>`. Omitting `room` selects `main`. Each room persists at `<dataDir>/room-<room>.json`.

A room slug comes from a directory path: lowercase the path, replace each run of characters that are not letters or digits with a hyphen, trim hyphens at both ends, and use `main` when the result is empty. The chat panel sends the working-directory path of the active conversation's project, so `/home/alice/code/wboard` becomes `home-alice-code-wboard`, and the page title shows the path's last segment as `[Board: wboard]`. The same message carries the chat session id, which the browser uses only to remember that session's last board position and zoom in `localStorage`.

```bash
curl -s 'http://localhost:6060/api/board?room=<room>'
curl -sS -X POST 'http://localhost:6060/api/board/edit?room=<room>' -H 'content-type: application/json' -d '{"puts":[],"deletes":[]}'
```

## Running the services

Install the dependencies first with `npm ci` in this directory; they are separate from the repository's pnpm workspace.

The sync server and the web server each run as a systemd user service. Save the two unit files below under `~/.config/systemd/user/`, with `WorkingDirectory` set to this directory.

`wb-sync.service`:

```ini
[Unit]
Description=Whiteboard sync server

[Service]
WorkingDirectory=/path/to/t3code/fork/whiteboard
ExecStart=/usr/bin/env npm run server
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

`wb-web.service`:

```ini
[Unit]
Description=Whiteboard web server

[Service]
WorkingDirectory=/path/to/t3code/fork/whiteboard
ExecStart=/usr/bin/env npm run dev
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Then enable both. `enable-linger` keeps user services running after you log out.

```bash
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now wb-sync wb-web
```

Restart after a configuration change with `systemctl --user restart wb-sync wb-web`; read a log with `journalctl --user -u wb-sync -f` or `journalctl --user -u wb-web -f`.

The whiteboard page is at `http://localhost:<webPort>/`. The same port serves the chat under `/chat/` and the sync websocket under `/sync/`, so exposing `webPort` alone is enough. The Vite dev server binds localhost only. Its HMR transport is intentionally disabled for this persistent page, so refresh manually after changing client source.

## Embedded chat

The chat panel is an iframe holding a T3 Code instance served on `chatPort`. This directory is `fork/whiteboard/` of a T3 Code fork ([orbitingflea/t3code](https://github.com/orbitingflea/t3code)); the T3 Code at the repository root, two levels up, carries the whiteboard's embedding changes, and `run-t3.sh` here starts it. The instance keeps its own data directory and never reads a personal T3 installation. Vite proxies `/chat/` on `webPort` to it, together with the chat's own `/api`, `/ws`, and `/.well-known` paths, so the iframe loads from the whiteboard's origin. See [run-t3.md](run-t3.md) for how to build and run it.

## Tests

Unit tests: `npm test`. Browser probes: see [probes/README.md](probes/README.md).
