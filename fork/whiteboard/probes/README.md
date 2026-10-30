# Browser probes

Keep the sync server and Vite running on their configured ports, then execute the probes with the local Chrome installation:

```bash
node probes/board-math.mjs
node probes/board-reference.mjs
```

The probes open `http://127.0.0.1:6061` and use `/opt/google/chrome/chrome` by default. Override the endpoints with `WHITEBOARD_URL` and `WHITEBOARD_API_URL`. Screenshots are written to `/tmp/whiteboard-board-*.png` by default.
