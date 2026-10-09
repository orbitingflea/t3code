# Updating the personal live install

The live install is the user's own T3 Code: `t3code.service` (user unit, 127.0.0.1:3773, drop-in `~/.config/systemd/user/t3code.service.d/override.conf`), state in `~/.t3/userdata`. The launcher `~/.t3/runtime/service-launcher.mjs` starts the version named by `activeVersion` in `~/.t3/runtime/service-state.json`, from `~/.t3/runtime/versions/<version>/`. Check `systemctl --user status t3code.service` first: if the unit is disabled and inactive, ask the user whether they still use it before building anything.

`~/.t3/userdata` is live data. Touch it only through the switch script below, which snapshots it first.

## Scripts

Durable copies live in `~/.t3/runtime/deploy-scripts/`. They hardcode `/tmp/t3-rebase-deploy` for logs, tarballs, and `stamp-package.mjs`, so start with `mkdir -p /tmp/t3-rebase-deploy && cp ~/.t3/runtime/deploy-scripts/* /tmp/t3-rebase-deploy/`.

- `pack.sh <worktree> <version>`: web `vp build`, stamps the version into `apps/server/package.json` (it must happen before the server build, which bakes the version in), `node scripts/cli.ts build`, `stamp-package.mjs` (resolves `catalog:` deps the way `cli.ts publish` does), nightly favicons, `vp pm pack`. Prints the tarball path.
- `stage.sh <tarball> <version>`: `npm install` into a staging dir, writes `.install-complete`, runs `__service-preflight` against a scratch DB, renames into `~/.t3/runtime/versions/<version>`.
- `switch-main-5.sh`: the last switch, used as a template. Copy it to `switch-main-<n>.sh` and set `NEWV`, `OLDV` (the current `activeVersion`), and the `.bak-switch-main-<n>` suffixes. It snapshots the DB with `VACUUM INTO`, updates the launcher, sets the state, restarts, probes 3773 for 200, and on failure restores DB, launcher, and state and restarts the old version.

## Steps

1. Build from a clean worktree at `origin/main`, never from the main checkout. Version string: `<upstream base version>-nightly.<yyyymmdd>.<upstream nightly number>.main.<n>`, the format of the existing names in `~/.t3/runtime/versions/`.
2. `pack.sh`, then `stage.sh`. Stage done when preflight prints `"status":"ready"` with the new version.
3. Run the switch script detached so a restart cannot take your session down: `systemd-run --user --unit switch-main-<n> bash ~/.t3/runtime/switch-main-<n>.sh`. Read the result in `~/.t3/runtime/switch-main-<n>.log`: `SUCCESS` plus the served `index-*.js` bundle name, or a rollback report.
4. New upstream DB migrations run on first start, so the DB snapshot `~/.t3/userdata/state.sqlite.bak-switch-main-<n>` is the only way back to the old version. Keep it until the user confirms the new version works.
