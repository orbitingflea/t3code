---
name: t3code-routine-update
description: Routine update ("常规更新") of the user's T3 Code fork - merge upstream into fork main, then deploy a fork main commit to the whiteboard (the running wb-t3 service and the whiteboard sandboxes). Use when the user asks to update/sync T3 Code with upstream or refresh the whiteboard chat.
---

# T3 Code routine update

A routine update carries upstream T3 Code into everything the user runs, in this order: fork `main` → the whiteboard deployment (the running `wb-t3` service and the whiteboard sandboxes). Finish and verify a stage before starting the next.

## Layout

- Main checkout `~/utils/t3code`: `origin` = orbitingflea/t3code (the fork), `upstream` = pingdotgg/t3code. It only ever fast-forwards to `origin/main`; all merging, building, and editing happen in worktrees (other agent sessions read this checkout).
- Fork `main` = upstream + the fork's carried changes, kept by **merge** (merge commit titled `Merge upstream main <short-sha> (<date>) into the fork`). The fork's modified surface is `git diff --stat upstream/main origin/main` (after a merge; before one, diff against `git merge-base origin/main upstream/main`). `git log --no-merges upstream/main..origin/main` also lists history that no longer ships (the steer/fold fixes reverted in `c5c326d638`, older skill revisions), so read the diff, not the log. Drop a carried change when upstream ships an equivalent (check the upstream PR state). What the fork carries:
  - The whiteboard: `fork/whiteboard/`, `apps/web/src/fork/whiteboard/`, `apps/web/vite/fork/`, and the embedding changes `fork/whiteboard/run-t3.md` lists.
  - Account-change restarts for Codex (#29) and Antigravity (#30): `accountChanged` in `packages/provider-core/src/server/ProviderAdapter.ts`, `releaseIfAccountChanged` and `startBusyTurn` in `ProviderSessionManager.ts`, the Codex and Antigravity adapters, `AntigravityDriver.ts`, `packages/provider-acp/src/server/adapter.ts`, `telemetry/Identify.ts` (exports `CodexAuthJsonSchema`). The fork makes `profileDirectory` a required Antigravity adapter option, so new upstream tests that build the adapter need `profileDirectory: unusedProfileDirectory`.
  - Claude approval-cancel fixes: `guardPendingRequestCancellations` in `EventSink.ts`, `ProviderEventIngestor.ts`, `ClaudeAdapterV2.ts`.
  - Math rendered by default: `mathRenderingEnabled` defaults to `true` in `packages/contracts/src/settings.ts` and the mobile `AppearancePreferencesProvider.tsx`, with `docs/user/appearance.md`.
  - Bold around CJK punctuation: `remark-cjk-friendly` in `packages/shared` (`markdownPipeline.ts`, `package.json`, the `pnpm-workspace.yaml` catalog), tested in `ChatMarkdown.browser.test.tsx`.
  - This skill (`.agents/skills/t3code-routine-update/`); always keep it.
- The whiteboard is part of the fork. `fork/whiteboard/` holds its code with its own `package.json` (install with `npm ci` there; it is not a pnpm workspace member). The fork's T3 Code carries the whiteboard's embedding changes, switched by environment variables on the server (`T3CODE_UNSAFE_NO_AUTH`, `T3CODE_CLAUDE_PLUGIN_ROOT`, `T3CODE_CODEX_SKILL_ROOT`, all set by `fork/whiteboard/run-t3.sh`) and by `VITE_T3_WHITEBOARD=1` for the web build. `fork/whiteboard/run-t3.md` lists every embedding change with its files; it is the checklist when an upstream merge moves or deletes one of them.
- Whiteboard deployment `~/.whiteboard/app`: a detached worktree of `~/utils/t3code` at the deployed fork commit (T3 Code at its root, the whiteboard in `fork/whiteboard`). User units `wb-sync` and `wb-web` run from `fork/whiteboard`; `wb-t3.service` runs `fork/whiteboard/run-t3.sh` on 127.0.0.1:6070 with state in `~/.whiteboard/t3-userdata`. Browsers reach the chat only via wb-web's `/chat/` proxy. `~/.local/bin/t3` runs this worktree's server. The sandboxes (`~/utils/wb-sandbox`) mount releases built from a fork commit.

## Steps

Before touching anything: `git fetch upstream && git fetch origin`, then report how many commits `main` is behind `upstream/main` and run `git merge-tree --write-tree --name-only origin/main upstream/main` to preview conflicts. Save the push-rule baseline: `git diff --name-only $(git merge-base origin/main upstream/main) origin/main | sort` (the surface) and the added lines of that diff matching `eslint-disable|oxlint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|biome-ignore|@effect-diagnostics` (the suppressions).

The user's standing rule (`~/utils/t3code/project-docs/rules/fork-rules.md`) lets a routine update be pushed without asking when it does not widen the fork's surface and adds no suppression comment; otherwise stop before pushing and report it for review. Check that rule there for whether stage 2 also needs the user.

### 1. Merge upstream into fork main

1. In a fresh worktree on a branch from `origin/main`, `git merge upstream/main` with the title above.
2. Resolve conflicts per carried change, keeping upstream's structure and re-applying the fork's change on top of it; when upstream rewrote code the fork had factored out (e.g. `startTurn` into `startBusyTurn`), move upstream's new body into the fork's helper rather than keeping the fork's old copy. When upstream moved or deleted a file that an embedding change touches, re-port that change into upstream's new location, guided by `fork/whiteboard/run-t3.md`, and update its file lists. `pnpm-lock.yaml`: take upstream's file, then `pnpm install --lockfile-only` so the fork's extra packages are added back. Do this even when git merges the lockfile without a conflict: a textual merge can drop upstream's patched-package references (it lost `micromark`'s `patch_hash` in 2026-10). The merge commit body names how non-trivial conflicts were resolved.
3. `vp i`. Then diff `dev/lib/syntax.js` and `package.json` of `node_modules/.pnpm/micromark-extension-gfm-table@*_patch_hash=*/node_modules/micromark-extension-gfm-table/` against the same files in `~/utils/t3code`: pnpm sometimes leaves this patched package unpatched (math in tables then breaks). If they differ, copy the two files over and delete `apps/web/node_modules/.vite`. The same check applies after every install below.
4. Run the tests and typecheck of each package a carried commit touches, including the tests named in `run-t3.md` (e.g. `cd apps/web && vp test run --project browser src/components/ChatMarkdown.browser.test.tsx`; browser tests only run from `apps/web`), then `vp run check:changed upstream/main` (against `upstream/main` it checks exactly the fork's surface; the default picks the same base). If `vp` is not on `PATH`, use `pnpm install --frozen-lockfile` and `<repo>/node_modules/.bin/vp`. The first one to three browser runs after an install can fail with "Vite unexpectedly reloaded a test" or dynamic-import errors while Vite optimizes new deps; rerun before treating a failure as real. Inside `wb-t3` your shell inherits `T3CODE_UNSAFE_NO_AUTH` and the other `T3CODE_*` variables `run-t3.sh` sets; unset them for test runs and smoke tests, or the auth and adapter tests fail.
5. Push-rule check: `git diff --name-only upstream/main HEAD | sort` must list no file missing from the baseline surface, and the added suppression lines of `git diff upstream/main HEAD` must be the baseline's. If both hold (or the user approves): `git push origin HEAD:main`, then `git -C ~/utils/t3code merge --ff-only origin/main`. Remove the worktree and delete its branch.

Done when `origin/main` contains `upstream/main`, every `run-t3.md` point still holds in the code, touched tests and typecheck pass, and the main checkout sits at `origin/main`.

### 2. Deploy fork main to the whiteboard

Run in `~/.whiteboard/app`. Note its current commit first (`git rev-parse HEAD`); the rollback needs it.

1. `git fetch origin && git checkout --detach origin/main` (or `--detach <sha>` for a specific fork commit). The working tree must be clean before and after.
2. `pnpm install --frozen-lockfile` at the root, then the micromark check from stage 1 step 3; then `npm ci` in `fork/whiteboard`.
3. Build to a side dir: `cd apps/web && VITE_T3_WHITEBOARD=1 vp build --outDir dist.new`; check that `dist.new/index.html` references `/chat/assets/` and `dist.new/manifest.webmanifest` has `#0a0a0a` (a build without the variable is a normal T3 Code build and does not work behind `/chat/`); move `dist` to `~/.whiteboard/chat-dist.old-<yyyymmdd>` and `dist.new` to `dist`.
4. Snapshot the DB read-only into `statev2.sqlite.bak-sync-<yyyymmdd>` beside the live file, then check `PRAGMA integrity_check` on the copy. The V1 `state.sqlite` there is no longer written.

   ```bash
   D=~/.whiteboard/t3-userdata/userdata
   bun -e 'import { Database } from "bun:sqlite"; const [src,dst]=process.argv.slice(1); const db=new Database(src,{readonly:true}); db.run("VACUUM INTO ?",[dst]); db.close();' "$D/statev2.sqlite" "$D/statev2.sqlite.bak-sync-<yyyymmdd>"
   ```

5. Smoke test on a pruned copy: `node apps/server/scripts/migrate-dev-db.ts --source <the step-4 snapshot> --base-dir /tmp/wbt3-smoke`, with `T3CODE_UNSAFE_NO_AUTH` unset. Never smoke-test on a raw VACUUM copy: it keeps in-flight runs, and the smoke server resumes them as real agents, including the thread running this update. Then run `T3_DATA=/tmp/wbt3-smoke T3_PORT=6079 setsid bash fork/whiteboard/run-t3.sh` in the background, wait for it to listen, and expect 200 from `http://127.0.0.1:6079/chat/` and a JSON reply from `/api/auth/session`. Also check that a websocket to `ws://127.0.0.1:6079/ws?orchestrationProtocol=2` stays open for 5 s and answers a `subscribeServerConfig` request; a socket that closes at once leaves the page stuck on "Still connecting". Stop it by its process group, then also kill the 6079 owner from `ss -H -ltnp` after checking that its `/proc/<pid>/environ` has `T3_DATA=/tmp/wbt3-smoke` (the server forks a child that keeps the port; its cwd matches the live `wb-t3`, so cwd proves nothing). "Unknown source control provider" log errors are harmless.
6. Deploy the commit to every whiteboard sandbox (`~/utils/wb-sandbox`). Each sandbox mounts a release built from a fixed commit, so restarting a sandbox does not update it. Run `~/utils/wb-sandbox/bin/wb-sandbox list` and note each sandbox's COMMIT (the rollback needs it). Then, for each NAME, run `~/utils/wb-sandbox/bin/wb-sandbox rebuild <name> --commit <the fork sha>`. The user runs this update only when restarts are fine, so rebuild all of them without asking.
   - Each rebuild restarts that sandbox's whiteboard and T3 services, which interrupts its running threads. A stopped sandbox is started and left running.
   - The first rebuild builds the shared release `/srv/whiteboard/<sha>` and takes several minutes; run it in the background or with a long timeout. Then run the micromark check against `/srv/whiteboard/<sha>` (the release's T3 Code root); if it differs, tell the user before rebuilding the rest.
   - A failed rebuild leaves that sandbox on its previous release and exits non-zero. Stop at the first failure and show the user the error tail; the release is shared, so the rest would fail the same way.
   - Done when `list` shows the new commit for every sandbox.
7. Restart `wb-t3` last, after pushes and memory notes are written. The restart stops every agent session `wb-t3` runs, even though they live in their own `t3code-*.scope` cgroups, so `/proc/$$/cgroup` does not show whether you are one of them. Check `tr '\0' '\n' < /proc/$$/environ | grep -q '^WB_CHAT_PID='` instead (`run-t3.sh` exports it): if it matches, you run under `wb-t3` and a direct restart kills you mid-turn. Then tell the user that running `wb-t3` threads will be interrupted, schedule the restart with `systemd-run --user --on-active=30s systemctl --user restart wb-t3`, and end the turn; check it in the next turn. Otherwise restart directly. Either way, check the `journalctl --user -u wb-t3` tail and that `/chat/` on 6070 answers 200. When the deployed range changes `fork/whiteboard` (`git diff --stat <previous sha>..HEAD -- fork/whiteboard`), restart `wb-sync` and `wb-web` as well; they run no agents.

Done when `~/.whiteboard/app` sits at the pushed fork `main`, the smoke test passed, every sandbox runs the new commit, and `wb-t3` runs the new build.

## Rollback

Every stage leaves a way back: fork main is a merge (revert or reset to the previous tip); the whiteboard deployment has the DB snapshot, the old `dist`, and the previous commit (`git checkout --detach <previous sha>`, rebuild, restart). A sandbox goes back with `wb-sandbox rebuild <name> --commit <its COMMIT from the step-6 list>`; a release is deleted once no sandbox uses it, so this usually builds it again (several minutes).

## Afterwards

Update the memory notes that record current state (fork scope, whiteboard deployment state) with the new shas and date, replacing the old values.

## Personal live install (optional)

The user's own install (`t3code.service`, port 3773, `~/.t3/runtime`) is updated only when the user asks; it uses a separate build-and-switch recipe in [`live-install.md`](live-install.md).
