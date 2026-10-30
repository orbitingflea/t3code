---
name: use-whiteboard
description: Read and draw on the shared whiteboard next to the chat. Use when the user asks to draw, sketch, or put something on the board, when the user asks what is on the board, when a message contains a `board://` link, or when you need the conclusions the user and earlier agents recorded on the board for this project.
---

# Use the whiteboard

The whiteboard is a tldraw board the user sees next to this chat. Each project has its own room, the board content `wb` reads and writes for that project. The room holds the conclusions the user and earlier agents reached for this project, so read it before you carry that work further.

Work on the board with the `wb` command. `wb --help` prints the syntax. Every command's options and examples are in [commands.md](commands.md). A command that succeeds prints one JSON value on stdout.

## Room

`wb` picks the room of the chat that runs it, from that chat's project directory, so it lands on the same board from any directory. Outside a chat it uses the directory it runs in. Inside a git repository the room comes from the main checkout of that repository, so a subdirectory and a linked worktree get the same room as the project.

## Steps

1. Read the board with `wb read`. It prints one entry per shape with its id, type, position, size, text, and style. Give it a board link (defined below) to get the shapes in that region. A hand-drawn shape has no text. To see a drawing, take a picture with `wb shot` and open the PNG.
2. Draw with `wb write`. You set every position. Read the coordinates that step 1 printed, then place new content below or to the right of the existing shapes.
3. Check the result before you reply: take a picture of the region you changed with `wb shot`, open the PNG, and fix what is wrong. Look for new content on top of existing shapes, label or note text that runs past its box, a formula shown as raw `$...$` text, an arrow whose end misses its target, and a wrapped line that leaves one word alone on the last line, which a different `--size` width would fix.
4. Refer to what you drew with a board link.

Edit and delete the shapes you created; their ids start with `shape:wb-`. Change a shape the user drew when the user asks for it.

## Board links

A board link names a rectangle of the board: `board://r/<x>,<y>,<w>,<h>`, four integers in the same coordinates that `wb read` prints and `--at` takes. When the user selects a region, the chat receives a Markdown link such as `[Area 1](board://r/120,80,300,180)`. Keep that Markdown form in replies, so the user can click it. `wb read` and `wb shot` accept a board link as their region.

## Pages

A board can have several pages, which the user switches in the page menu at the top left. `wb pages` lists them. Without a region or `--page`, `wb read` lists the shapes of every page, and each entry names its `page`. `--page` picks one page for `read`, `write`, and `shot`, by number from 1, by name, or by id. Without it, `write` and `shot` use the first page. A board link to a region on any page but the first carries the page, as `board://p/<page>/r/<x>,<y>,<w>,<h>`, and `wb read` and `wb shot` follow that page. When the user works on a page other than the first, pass that page to every command.

## Mathematics

In shape text, write each formula as `$...$` with no line break inside it. The board renders those spans. In chat replies, `$...$` renders inline and `$$...$$` as a block.

## Beyond plain shapes

`wb read` lists every shape, including frames, groups, and images, with the fields plain shapes share. `wb write` creates and edits plain shapes. Everything else, such as a frame's name, an image, arrow bindings, custom `meta`, and several records in one atomic batch, goes through the raw record commands in [raw-records.md](raw-records.md).
