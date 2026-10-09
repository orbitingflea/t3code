---
name: t3code-routine-update
description: Routine update ("常规更新") of the user's T3 Code fork - merge upstream into fork main, rebase the `wb` branch, move the whiteboard's chat-t3 submodule to the new `wb` and restart wb-t3. Use when the user asks to update/sync T3 Code with upstream or refresh the whiteboard chat.
---

# T3 Code routine update

A routine update carries upstream T3 Code into everything the user runs, in this order: fork `main` → fork `wb` → whiteboard `chat-t3` (the running `wb-t3` service). Each stage builds on the previous one; finish and verify a stage before starting the next.

## Layout

- Main checkout `~/utils/t3code`: `origin` = orbitingflea/t3code (the fork), `upstream` = pingdotgg/t3code. It only ever fast-forwards to `origin/main`; all merging, building, and editing happen in worktrees (other agent sessions read this checkout).
- Fork `main` = upstream + a few fork-only commits, kept by **merge** (merge commit titled `Merge upstream main <short-sha> (<date>) into the fork`). Find the carried commits with `git log --no-merges upstream/main..origin/main`; drop one when upstream has an equivalent (check the upstream PR state). This skill (`.agents/skills/t3code-routine-update/`) is itself a carried commit; always keep it.
- Fork `wb` = fork `main` + the whiteboard embedding commits (`git log origin/main..origin/wb`). Worktree `~/utils/t3code-wb`. `run-t3.md` at the repo root lists every embedding change with its files; it is the porting checklist.
- Whiteboard repo `~/research/whiteboard` (origin orbitingflea/whiteboard). `chat-t3/` is a git submodule (origin = the fork) pinned to a `wb` commit, served by user unit `wb-t3.service` on 127.0.0.1:6070, state in `~/.whiteboard/t3-userdata`. Browsers reach it only via wb-web's `/chat/` proxy.

## Steps

Before touching anything: `git fetch upstream && git fetch origin`, then report how many commits `main` is behind `upstream/main` and run `git merge-tree --write-tree --name-only origin/main upstream/main` (and the same for `origin/wb`) to preview conflicts. Confirm with the user which stages to run.

### 1. Merge upstream into fork main

1. In a fresh worktree on a branch from `origin/main`, `git merge upstream/main` with the title above.
2. Resolve conflicts per carried commit, keeping upstream's structure and re-applying the fork fix (the `resolving-merge-conflicts` skill covers the method). `pnpm-lock.yaml`: take upstream's file, then `pnpm install --lockfile-only` so the fork's extra packages are added back. The merge commit body names how non-trivial conflicts were resolved.
3. `vp i`, then run the tests and typecheck of each package a carried commit touches (e.g. `vp test run apps/web/src/components/ChatMarkdown.test.tsx`).
4. After the user approves: `git push origin HEAD:main`, then `git -C ~/utils/t3code merge --ff-only origin/main`. Remove the worktree.

Done when `origin/main` contains `upstream/main`, touched tests and typecheck pass, and the main checkout sits at `origin/main`.

### 2. Rebase `wb`

1. In `~/utils/t3code-wb`: create `backup/wb-pre-rebase-<yyyymmdd>` at the current tip, then `git rebase origin/main`.
2. When upstream moved or deleted a file an embedding commit changed, re-port that change into upstream's new location, guided by `run-t3.md`; update `run-t3.md`'s file lists to match.
3. `vp i`, run the tests of every file the embedding commits touch (`git diff --name-only origin/main...HEAD`) plus typecheck of the touched packages.
4. After the user approves: `git push origin backup/wb-pre-rebase-<yyyymmdd>` and `git push --force-with-lease origin wb`.

Done when `wb` = `origin/main` + embedding commits, every `run-t3.md` point still holds in the code, and tests pass.

### 3. Refresh whiteboard chat-t3

Run in `~/research/whiteboard` on a new branch `t3-sync-<wb-short-sha>`.

1. Move the submodule (stage 2 must have pushed `wb`): `git -C chat-t3 fetch origin && git -C chat-t3 checkout <wb-sha> && git add chat-t3`. Check that `git submodule status` shows `<wb-sha>` and `git -C chat-t3 status --short` is empty.
2. `cd chat-t3 && pnpm install --frozen-lockfile`, then immediately `git -C ~/research/whiteboard config --unset core.hooksPath` (T3's prepare script hijacks the whiteboard's hooks).
3. Build to a side dir: `cd chat-t3/apps/web && vp build --outDir dist.new`; check `dist.new/index.html` references `/chat/assets/`; move `dist` to `~/.whiteboard/chat-dist.old-<yyyymmdd>` and `dist.new` to `dist`.
4. Snapshot the DB: bun `VACUUM INTO` from `~/.whiteboard/t3-userdata/userdata/state.sqlite` to `state.sqlite.bak-sync-<yyyymmdd>` beside it (the AGENTS.md "Test data" snippet shows the command).
5. Smoke test on a copy: VACUUM another snapshot into `/tmp/wbt3-smoke/userdata/state.sqlite`, run `T3_DATA=/tmp/wbt3-smoke T3_PORT=6079 setsid bash chat-t3/run-t3.sh` in the background, wait for it to listen, and expect 200 from `http://127.0.0.1:6079/chat/` and a JSON reply from `/api/auth/session`. Also check that a websocket to `ws://127.0.0.1:6079/ws?orchestrationProtocol=2` stays open for 5 s and answers a `subscribeServerConfig` request; a socket that closes at once leaves the page stuck on "Still connecting". Stop it by its process group, then also kill the 6079 owner from `ss -H -ltnp` after checking its `/proc/<pid>/cwd` (the server forks a child that keeps the port). "Unknown source control provider" log errors are harmless.
6. Commit `Refresh chat-t3 to fork wb@<wb-short-sha>`. Ask the user: PR, or fast-forward whiteboard `main` and push directly. GitHub reports a bypassed "changes must be made through a pull request" rule on direct push; that is expected.
7. Restart `wb-t3` last, after commits, pushes, and memory notes are written. Check `cat /proc/$$/cgroup` first: if it contains `wb-t3.service`, you run inside the service (KillMode=control-group) and a direct restart kills you mid-turn. Schedule it instead: `systemd-run --user --on-active=30s systemctl --user restart wb-t3`, tell the user, and end the turn. Otherwise restart directly and check the `journalctl --user -u wb-t3` tail and that `/chat/` on 6070 answers 200.

Done when the whiteboard `chat-t3` submodule points at the pushed `wb` tip, the smoke test passed, the commit is pushed or in a PR, and `wb-t3` runs the new build.

## Rollback

Every stage leaves a way back: fork main is a merge (revert or reset to the previous tip), `wb` has its backup branch, whiteboard has the DB snapshot, the old `dist`, and the previous commit.

## Afterwards

Update the memory notes that record current state (fork scope, whiteboard sync state) with the new shas and date, replacing the old values.

## Personal live install (optional)

The user's own install (`t3code.service`, port 3773, `~/.t3/runtime`) is updated only when the user asks; it uses a separate build-and-switch recipe in [`live-install.md`](live-install.md).
