# Board references

A person marks a rectangle of the board and sends it to the chat as `[Area N](board://r/x,y,w,h)`. A `board://` link in the chat highlights its region on the board when hovered, with an arrow from the link, and an arrow at the board's edge when the region is offscreen. `wb read` and `wb shot` take the same links.

## Sub-features

- `ref-tool` the Reference region tool turns a dragged rectangle into an `Area N` reference.
- `ref-hover` hovering a link highlights the region and draws one arrow from the link.
- `ref-offscreen` a region outside the view gets an arrow at the board's edge, above the toolbar, without moving the camera.
- `ref-cli` `wb read` and `wb shot` accept `board://r/...` and `board://p/<page>/r/...`.

## How to get to it (user POV)

- Choose Reference region, the first tool in the bottom toolbar, and drag on the canvas.
- Hover or click a `board://` link in an assistant message or an `Area N` chip in the composer.
- An agent passes a link to `wb read` or `wb shot`.

## Driving it with wb-verify

Preconditions: a run from `up --seed <slug>` whose room `main` shows at least one shape in the initial view; env loaded.

- **Hover and offscreen.** `WHITEBOARD_PROBE_SCREENSHOT=$WB_VERIFY_RUN/evidence/board-reference.png WHITEBOARD_PROBE_OFFSCREEN_SCREENSHOT=$WB_VERIFY_RUN/evidence/board-reference-offscreen.png node fork/whiteboard/probes/board-reference.mjs`. Exit 0. Open both PNGs: a highlighted rectangle with one arrow to it, and an edge arrow over the board.
- **Tool to chat.** Run the region step of [chat-embedding](./chat-embedding.md): the composer gets an `Area 1` chip.
- **CLI.** The region steps of [wb-cli](./wb-cli.md).

## Gotchas

- The probe calls the page's bridge module directly to start the hover, so it proves the drawing, not the chat's hover message. The chat sends `wb-hover` when an `Area N` chip in the composer is hovered, which the chat journey does not do yet. Links in an assistant message, which also send `wb-highlight` on click, need a provider turn and are not mapped yet.
- `Area N` numbers restart at 1 on each page load.
