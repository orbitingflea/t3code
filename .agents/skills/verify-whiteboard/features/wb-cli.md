# Agent board CLI

Agents read and draw on a project's board with `wb`. Each command prints one JSON value, and every change shows up live on the page and in the room's stored JSON.

## Sub-features

- `cli-pages` lists the room's pages with their shape counts.
- `cli-read` lists shapes on every page, one page (`--page`), or a region (`x,y,w,h` or a `board://` link).
- `cli-write` creates a shape (`--type text|rect|ellipse|line|arrow|note`) and prints its new `shape:wb-*` id.
- `cli-mermaid` creates and changes a Mermaid diagram (`--type mermaid --text=SOURCE`), sized from the diagram's own aspect ratio.
- `cli-edit` changes an existing shape with `write --id <id>`.
- `cli-delete` removes shapes by id.
- `cli-shot` renders a region or a page to PNG through the board page, in the theme `--theme light|dark` names (default `dark`).
- `cli-raw` reads and writes raw tldraw records (`read-raw`, `write-raw`).

## How to get to it (user POV)

- An agent in the chat runs `wb` from `fork/whiteboard/tools/bin`, which `run-t3.sh` puts on `PATH`. Its room comes from the chat's project.
- A person in a terminal runs `node fork/whiteboard/tools/wb.mjs` with `--room`.

## Driving it with wb-verify

Preconditions: a run from `up --seed <slug>` with a non-empty room; env loaded.

- **List.** `wb pages`. Exit 0 and at least one page with a `shapes` count.
- **Read.** `wb read > $WB_VERIFY_RUN/evidence/read-before.json`. One entry per shape with `id`, `type`, `x`, `y`, and `w`, `h` where the shape stores a size.
- **Create.** Below the existing shapes, `wb write --type note --at 100,1100 --text 'verify: $a^2+b^2=c^2$'` and `wb write --type rect --at 400,1100 --size 240,120 --text 'verify box' --color blue`. Each prints a new `shape:wb-*` id.
- **Edit.** `wb write --id <rect id> --text 'verify box edited'`. Same id, same geometry.
- **Read a region.** `wb read board://r/80,1080,600,200`. Both new shapes, with the edited text. Seeded shapes in that area appear too.
- **Picture.** `wb shot board://r/80,1080,600,200 --out $WB_VERIFY_RUN/evidence/region.png`. Open it: a yellow note with the formula typeset, and a blue box reading `verify box edited`, on a dark background. Run the same region with `--theme light --out $WB_VERIFY_RUN/evidence/region-light.png`: the same shapes on a light background. `wb shot --theme blue` exits 1 with "--theme expects light or dark".
- **Mermaid.** Write a `stateDiagram-v2` with Chinese labels and an `%%{init: {"theme":"forest"}}%%` line to `$WB_VERIFY_RUN/evidence/chart.mmd`, then `wb write --type mermaid --at 100,1400 --text="$(cat $WB_VERIFY_RUN/evidence/chart.mmd)"`. It prints a new id with `w` and `h`. `wb read` lists it with `type: "mermaid"` and the source as `text`. `wb shot` of its region with `--theme light` and with `--theme dark`: the diagram in Mermaid's default (purple) and dark colors, not forest green, each label inside its box. `wb write --id <id> --size 300` keeps the aspect ratio. `wb write --type mermaid --at 0,0 --text=$'stateDiagram-v2\n  [*] --> '` exits 1 with Mermaid's parse error, and `wb read` shows no new shape.
- **Stored.** `curl -s "$WHITEBOARD_API_URL/api/board?room=main" | jq '[.[] | select(.id | startswith("shape:wb-"))]'`. The three new ids are in the list.
- **Delete.** `wb delete <note id> <rect id> <mermaid id>`. Prints all three under `deleted`; `wb read` is back to the count in `read-before.json`.

## Gotchas

- `--id` edits; it does not name a new shape. `write --id <new name> --type note` fails with "--type cannot be changed on an existing shape".
- `shot` drives Chrome through the run's page (`webPort`) and takes about 5 s.
- Without `wb-verify.sh wb`, `wb` uses the real HOME's config, so it writes to the live board, in the room of this checkout's main folder.
