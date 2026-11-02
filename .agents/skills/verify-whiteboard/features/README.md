# Whiteboard verification map

This directory is the maintained source for verifying what users and agents do with the fork's whiteboard. Read this index, then follow the feature file that matches the change.

## Baseline preconditions

- A run started by this skill's `wb-verify.sh up`, healthy by `wb-verify.sh doctor <run>`, with `<run>/env` loaded.
- Board-only features run on a run without `--chat`. With the chat open on a project, the board follows that project's room instead of `main`, and the probes read `main`.
- Never drive the live whiteboard or a run another task started.

## Driving conventions

- `wb ...` below means `wb-verify.sh wb <run> ...`.
- Browser steps use `playwright-core` with `/opt/google/chrome/chrome` and a 1440×900 viewport, the setup of `fork/whiteboard/probes/`.
- Prefer test ids, roles, and the `wb-*` class names named in each file over coordinates. Board coordinates are fine where the feature is about positions.
- Put every artifact in `<run>/evidence/`.

## Proof and skip reporting

- Pair each action with what it produced on screen and in storage: a screenshot you opened, and `wb read` or the sync API's JSON.
- Report a step that could not run with the command tried and the unmet precondition. Do not count a different entry point as the one skipped.
- A probe failure is a failure. Do not edit the probe to pass.

## Feature entry contract

Each feature file has an H1, one paragraph of user-visible behavior, then four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with wb-verify`, and `Gotchas`.

## Features

- [Agent board CLI](./wb-cli.md): `wb` pages, read, write, edit, delete, and shot on a room.
- [Math on the board](./board-math.md): `$...$` text renders as KaTeX while editing and after, at several zoom levels.
- [Board references](./board-references.md): the Reference region tool, `board://` links, and their hover highlight and offscreen arrow.
- [Chat panel](./chat-embedding.md): T3 Code embedded under `/chat/`, the board following the chat's project, region references into the composer, and collapsing either panel.
