# `wb` command reference

Every command accepts `--room <absolute project directory>`, or the room name itself. Use it when the board shows a different project than the directory `wb` runs in.

## `wb pages`

```
wb pages
```

Prints one entry per page in page-menu order: `{page, id, name, shapes}`. `page` is the number from 1, and `shapes` counts the shapes on it. Every `--page` option below takes that number, the name, or the id.

## `wb read`

```
wb read [x,y,w,h | board://r/x,y,w,h] [--page P]
```

Prints one entry per shape: `{id, type, x, y, w, h, text, rotation, opacity, weight, color, fill, dash, font, page}`. `page` is the name of the page the shape is on. Lines and arrows also carry `start` and `end` points in the same coordinates as `x` and `y`. `rotation` is in degrees. Fields that do not apply to a shape are omitted.

Without a region or `--page`, the command prints the shapes of every page. With a region, it prints every shape on the region's page whose bounding box overlaps the region. A region's page is the one its board link names, else `--page`, else the first page. The box of a text shape is an estimate, because its height is not stored.

```bash
wb read 'board://r/120,80,300,180'
```

## `wb write`

```
wb write [--page P] [--id ID] [--type text|rect|ellipse|line|arrow|note] --at x,y [--to x2,y2]
         [--text "..."] [--size w,h] [--color C] [--fill F] [--dash D]
         [--weight s|m|l|xl] [--font draw|sans|serif|mono] [--rotate degrees]
         [--opacity 0..1] [--order front|back]
```

- `--at` is the top-left corner, or the start point of a line or arrow. A new shape requires it.
- `--type` defaults to `text`.
- `--page` puts a new shape on that page; the default is the first page. With `--id`, it moves the shape to that page.
- `--size w,h` sets the width and height of a `rect` or `ellipse`. `--size w` sets the width of a `text` shape, and the text wraps at that width. `--to` sets the end point of a `line` or `arrow`.
- `--text` is the body of a `text` or `note` shape, or the label of a `rect`, `ellipse`, or `arrow`. `$...$` spans render as mathematics. Each newline starts a new line. A run of lines that begin with `- ` becomes one bulleted list.
- `--color`, `--fill`, and `--dash` take tldraw style names. Colors: `black`, `grey`, `light-violet`, `violet`, `blue`, `light-blue`, `yellow`, `orange`, `green`, `light-green`, `light-red`, `red`, `white`. Fills: `none`, `semi`, `solid`, `pattern`, `fill`, `lined-fill`. Dashes: `draw`, `solid`, `dashed`, `dotted`, `none`. `--fill` applies to `rect`, `ellipse`, and `arrow`. `--dash` also applies to `line`.
- `--weight` is tldraw's `size` style. It scales the font size and the stroke width.
- `--rotate` takes degrees clockwise.
- `--order front` or `--order back` moves the shape above or below all other shapes in the room.

The command prints `{id, x, y}`, plus `w` and `h` when the shape has them.

```bash
wb write --type text --at 120,80 --text 'Bound: $\omega < 2.373$'
wb write --type rect --at 120,200 --size 240,120 --text 'Fast matrix multiplication' --color blue
wb write --type arrow --at 380,260 --to 620,260 --color violet
wb write --type note --at 700,80 --text 'Check the exponent' --color yellow --rotate 8
wb write --type text --at 120,420 --text 'Headline' --weight xl --opacity 0.6 --order front
wb write --type note --at 700,300 --text $'Todo\n- read the draft\n- send it' --color yellow
```

With `--id`, the command edits that shape. It changes only the options named on the command line. So `--at` alone moves the shape, and `--color` alone recolors it. For a line or arrow, `--at` and `--to` move the end points.

```bash
wb write --id shape:wb-abc123 --color orange
```

## `wb delete`

```
wb delete <id...>
```

Deletes the shapes with those ids.

## `wb shot`

```
wb shot [x,y,w,h | board://r/x,y,w,h] [--page P] [--out file]
```

Renders one page and writes a PNG. Prints `{file}`. The page is the one the board link names, else `--page`, else the first page. Without a region, the image fits the whole content of the page. With a region, the view frames that region. `--out` defaults to a file in the temporary directory.

```bash
wb shot 'board://r/120,80,300,180' --out /tmp/area1.png
wb shot --page 2
```
