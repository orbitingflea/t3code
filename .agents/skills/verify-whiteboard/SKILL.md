---
name: verify-whiteboard
description: Verify the fork's whiteboard (fork/whiteboard, a tldraw board with a sync server, the `wb` agent CLI, board references, and T3 Code embedded as its chat panel) by running a disposable instance and driving it like a user. Use after changing anything under fork/whiteboard or apps/web/src/fork/whiteboard, or when asked to prove whiteboard behavior. For T3 Code's own UI use test-t3-app or test-t3-mobile.
---

# Verify the whiteboard

The whiteboard is `fork/whiteboard/`: a tldraw page (Vite), a sync server that stores rooms as JSON, the `wb` CLI agents use to read and draw, and a chat panel that embeds this repository's T3 Code under `/chat/`. [features/README.md](features/README.md) maps what to verify. This skill covers only the whiteboard. T3 Code's own screens inside the chat panel are verified with [test-t3-app](../test-t3-app/SKILL.md), and its mobile app with [test-t3-mobile](../test-t3-mobile/SKILL.md).

All commands below run from the repository root. `wb-verify.sh` stands for `.agents/skills/verify-whiteboard/scripts/wb-verify.sh`.

## Launch

One-time setup in this checkout: `npm ci` in `fork/whiteboard`. For the chat panel also run `vp i` at the root and build T3's web app in whiteboard mode. Rebuild after any change under `apps/web` or `packages/`:

```bash
VITE_T3_WHITEBOARD=1 pnpm --dir apps/web run build
```

Start a run:

```bash
wb-verify.sh up                      # board only, empty room
wb-verify.sh up --seed <slug>        # board only, room "main" starts as a copy of ~/.whiteboard/data/room-<slug>.json
wb-verify.sh up --chat [--seed ...]  # also the embedded T3 Code chat
```

`up` prints the run directory once the checks in Doctor below pass. After 120 failed checks, about two minutes or more, it fails and prints where the logs are. A run gets free ports and its own `HOME` folder in `.t3/wb-verify/<run>/`. It never writes to `~/.whiteboard` and reads it only for the seed copy. Several runs can live side by side. `<run>/env` holds `WHITEBOARD_URL` (the page), `WHITEBOARD_API_URL` (the sync server), `WB_VERIFY_HOME`, `WB_VERIFY_RUN`, `WB_VERIFY_CHAT` (1 for a `--chat` run, else 0), and `WB_VERIFY_CHAT_URL` (the chat's T3 server, running only with `--chat`). Load it with `set -a; source <run>/env; set +a`.

Pick a seed from `ls ~/.whiteboard/data`. An empty room fails `board-reference.mjs`, which needs a visible shape.

## Doctor

```bash
wb-verify.sh doctor <run>
```

It is read-only and checks that each started process is alive, the sync API answers, the page is served, the page's `/sync` proxy reaches the sync server, and with `--chat` that `/chat/` serves T3's whiteboard build. Run it first whenever something looks off. A dead process names its log in `<run>/logs/`; a failing HTTP check names its URL.

## Drive

- **Agent CLI.** `wb-verify.sh wb <run> <wb args>` runs this checkout's `tools/wb.mjs` against the run with `--room main` preset. A later `--room` overrides it. `wb --help` prints the syntax.
- **Board page.** Use `playwright-core` with `/opt/google/chrome/chrome`, as the scripts in `fork/whiteboard/probes/` do. A script outside `fork/whiteboard` resolves it with `createRequire("<repo>/fork/whiteboard/package.json")`. Stable handles: `.tl-canvas`, `getByTestId("canvas")`, `getByTestId("tools.region-ref")` (the Reference region tool), `getByRole("separator")` (the panel divider), `.wb-show` (the Chat button), and `iframe[title="T3 Code chat"]`.
- **Probes.** With the run's env loaded, `node fork/whiteboard/probes/board-math.mjs` and `node fork/whiteboard/probes/board-reference.mjs`. Set `WHITEBOARD_PROBE_SCREENSHOT` (and `WHITEBOARD_PROBE_OFFSCREEN_SCREENSHOT` for the reference probe) to paths under `<run>/evidence/`.
- **Chat journey.** `node .agents/skills/verify-whiteboard/scripts/chat-journey.mjs <run>` drives a `--chat` run end to end. See [chat-embedding](features/chat-embedding.md).

Use only the URLs in the run's env. The probes default to ports 6060 and 6061, and `wb` with the real HOME uses `~/.whiteboard/config.json`; both can reach a live whiteboard on this machine, and people may be using it.

## Evidence

Save everything under `<run>/evidence/`, which `down` keeps. For each feature keep:

- the action: the exact command, or the script and the step it reached;
- the result as the user sees it: a screenshot (`wb shot ... --out <run>/evidence/<name>.png`, a probe screenshot, or the chat journey's `chat-*.png`), opened and looked at, not only written;
- the stored side effect: `wb read` output, or `curl "$WHITEBOARD_API_URL/api/board?room=<room>"`, saved as JSON.

Drive the user path. `wb` and the page are user paths. Writing `room-*.json` directly or calling `window` hooks is not, except where a probe already does it and the feature file says so.

## Cleanup

```bash
wb-verify.sh down <run>
```

It stops each process group it started, by the PID saved at spawn, and deletes the run's private HOME, chat state, and scratch project. `evidence/` and `logs/` stay. Remove a whole run directory with `rm -rf .t3/wb-verify/<run>` once its evidence is no longer needed. Never stop whiteboard or T3 processes by name: the live services and other runs match the same names.

## Helpers

- `scripts/wb-verify.sh up|doctor|wb|down`, described above. Run it without arguments for usage.
- `scripts/chat-journey.mjs <run>`: the chat panel journey. It prints a JSON summary of passed steps and saves `chat-failed.png` when a step fails.
