# Math on the board

A person types text with `$...$` on the board and sees the formula typeset with KaTeX, both while editing and after leaving the text. Text that agents write with `wb` renders the same way.

## Sub-features

- `math-edit` typesets a formula while the text is being edited.
- `math-commit` keeps the typeset formula after Escape.
- `math-zoom` stays correct at 90% and 51% zoom.
- `math-first-click` the first double-click after a hard reload starts text editing.
- `math-cli` a `wb write --text '$...$'` shape renders typeset.

## How to get to it (user POV)

- Choose the Text tool in the bottom toolbar, click an empty spot, and type `$\omega < 2.373$`.
- Double-click an empty spot on the canvas to start text there.
- An agent writes a shape with `$...$` in `--text`.

## Driving it with wb-verify

Preconditions: a run without `--chat`; env loaded.

- **Probe.** `WHITEBOARD_PROBE_SCREENSHOT=$WB_VERIFY_RUN/evidence/board-math.png node fork/whiteboard/probes/board-math.mjs > $WB_VERIFY_RUN/evidence/board-math.log`. Exit 0. It writes `board-math-90.png` and `board-math-51.png` beside the given path; open both and see `ω < 2.373` typeset.
- **CLI.** The `Create` and `Picture` steps of [wb-cli](./wb-cli.md) show a `wb`-written formula typeset in `region.png`.

## Gotchas

- The probe types into room `main` through the page and leaves its text shapes there.
- The probe reads `/api/board` without a room, which is `main`. If the board follows a chat project, it edits another room and fails.
