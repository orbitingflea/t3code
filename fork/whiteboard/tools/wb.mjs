#!/usr/bin/env node
// Agent-facing whiteboard CLI: read, write and delete board shapes, and screenshot a board region.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStreamConsumers from "node:stream/consumers";
import * as NodeUtil from "node:util";
import { getIndexAbove, getIndexBelow } from "@tldraw/utils";
import { config } from "../server/config.mjs";
import { boardRoom } from "../web/room.mjs";

const api = `http://${config.host}:${config.port}`;
const web = `http://${config.host}:${config.webPort}`;

function fail(message) {
  process.stderr.write(`wb: ${message}\n`);
  process.exit(1);
}

const usage = `usage:
  wb pages [--room R]
  wb read [x,y,w,h | board://r/x,y,w,h] [--page P] [--room R]
  wb write [--room R] [--page P] [--id ID] [--type text|rect|ellipse|line|arrow|note] --at x,y [--to x2,y2]
           [--text "..."] [--size w,h | w] [--color C] [--fill F] [--dash D]
           [--weight s|m|l|xl] [--font draw|sans|serif|mono] [--rotate degrees]
           [--opacity 0..1] [--order front|back]
  wb write [--room R] [--page P] [--id ID] --type mermaid --at x,y --text=SOURCE [--size w]
  wb delete [--room R] <id...>
  wb shot [x,y,w,h | board://r/x,y,w,h] [--page P] [--room R] [--out file] [--theme light|dark]
  wb read-raw [--room R]
  wb write-raw [--room R]   # reads {"puts":[...],"deletes":[...]} from stdin`;

if (process.argv.includes("--help")) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}

const { values: flags, positionals } = (() => {
  try {
    return NodeUtil.parseArgs({
      allowPositionals: true,
      options: {
        room: { type: "string" },
        id: { type: "string" },
        type: { type: "string" },
        at: { type: "string" },
        to: { type: "string" },
        text: { type: "string" },
        size: { type: "string" },
        color: { type: "string" },
        fill: { type: "string" },
        dash: { type: "string" },
        out: { type: "string" },
        weight: { type: "string" },
        font: { type: "string" },
        rotate: { type: "string" },
        opacity: { type: "string" },
        order: { type: "string" },
        page: { type: "string" },
        theme: { type: "string" },
      },
    });
  } catch (error) {
    return fail(`${error.message}\n${usage}`);
  }
})();

// The board follows the chat's project directory, so from any directory or a linked worktree wb must
// still land in the main checkout's room. The chat server (WB_CHAT_PID) starts each agent in its chat's
// project directory; the shells below the agent may have moved elsewhere.
function agentDir() {
  const chat = process.env.WB_CHAT_PID;
  if (!chat) return process.cwd();
  try {
    for (let pid = String(process.pid); pid !== "1";) {
      const parent = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8")
        .split(") ")
        .at(-1)
        .split(" ")[1];
      if (parent === chat) return NodeFS.readlinkSync(`/proc/${pid}/cwd`);
      pid = parent;
    }
  } catch {}
  return process.cwd();
}
function projectDir() {
  const cwd = agentDir();
  try {
    const gitDir = NodeChildProcess.execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
    return NodePath.dirname(gitDir);
  } catch {
    return cwd;
  }
}
const room = flags.room ? boardRoom(flags.room) : boardRoom(projectDir());

const point = (value, flag) => {
  const parts = String(value).split(",").map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n)))
    fail(`--${flag} expects two numbers, for example --${flag} 120,80`);
  return parts;
};

// A board link on a page other than the first names it: board://p/<page id without "page:">/r/x,y,w,h.
const region = (value) => {
  const match = /^(?:board:\/\/(?:p\/([\w-]+)\/)?r\/)?(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(value);
  if (!match) fail("region must be x,y,w,h or board://r/x,y,w,h");
  const [x, y, w, h] = match.slice(2, 6).map(Number);
  return { x, y, w, h, page: match[1] };
};

const pagesOf = (board) =>
  board.filter((record) => record.typeName === "page").sort((a, b) => (a.index < b.index ? -1 : 1));
// --page takes a page number counted from 1, a page name, or a page id; without one it is the first page.
function pageOf(board, value) {
  const pages = pagesOf(board);
  if (value === undefined) return pages[0];
  const name = value.toLowerCase();
  const page = /^\d+$/.test(value)
    ? pages[Number(value) - 1]
    : pages.find(
        (p) => p.id === value || p.id === `page:${value}` || p.name.toLowerCase() === name,
      );
  return (
    page ??
    fail(`no page ${value}; pages: ${pages.map((p, i) => `${i + 1} "${p.name}"`).join(", ")}`)
  );
}
// A shape inside a frame or group has that container as parent; its page is at the top of the chain.
// A room edited through write-raw can hold a shape whose parent is gone; it is on no page.
function pageIdOf(byId, shape) {
  let id = shape.parentId;
  while (id && !id.startsWith("page:")) id = byId.get(id)?.parentId;
  return id;
}

async function loadBoard() {
  const response = await fetch(`${api}/api/board?room=${room}`);
  if (!response.ok) fail(`board read failed: HTTP ${response.status}`);
  return response.json();
}

async function editBoard(puts, deletes) {
  const response = await fetch(`${api}/api/board/edit?room=${room}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ puts, deletes }),
  });
  if (!response.ok)
    fail(
      `board edit failed: ${(await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`}`,
    );
}

// Rich text uses the same document shape the board writes; the server turns $...$ spans into math nodes.
const paragraph = (text) => ({
  type: "paragraph",
  attrs: { dir: "auto" },
  ...(text ? { content: [{ type: "text", text }] } : {}),
});
const richText = (text) => {
  const content = [];
  for (const line of text.split("\n")) {
    // Each line is its own paragraph, except that a run of "- " lines collects into one bulleted list.
    if (!line.startsWith("- ")) {
      content.push(paragraph(line));
      continue;
    }
    const item = { type: "listItem", content: [paragraph(line.slice(2))] };
    if (content.at(-1)?.type === "bulletList") content.at(-1).content.push(item);
    else content.push({ type: "bulletList", content: [item] });
  }
  return { type: "doc", attrs: { dir: "auto" }, content };
};

function plainText(rich) {
  const visit = (node) => {
    if (node.type === "text") return node.text ?? "";
    if (node.type === "hardBreak") return "\n";
    if (node.type === "math_inline") return `$${(node.content ?? []).map(visit).join("")}$`;
    const inner = (node.content ?? []).map(visit).join("");
    if (node.type === "listItem") return `- ${inner}`;
    return inner + (node.type === "paragraph" ? "\n" : "");
  };
  return rich ? visit(rich).replace(/\n+$/, "") : "";
}

const linePoints = (shape) =>
  Object.values(shape.props.points).sort((a, b) => (a.index < b.index ? -1 : 1));
const endpoints = (shape) =>
  shape.type === "arrow"
    ? [shape.props.start, shape.props.end]
    : [linePoints(shape)[0], linePoints(shape).at(-1)];

// Maps a point in a shape's own frame to the page, given the shape's page transform; the rotation
// turns about the shape origin.
const toPage = (transform, point) => ({
  x: transform.x + point.x * Math.cos(transform.rotation) - point.y * Math.sin(transform.rotation),
  y: transform.y + point.x * Math.sin(transform.rotation) + point.y * Math.cos(transform.rotation),
});

// A shape's x, y and rotation are relative to its parent, a page or a group or frame shape.
// wb reads and writes page coordinates, so it composes the parent chain up to the page.
function parentTransform(byId, shape) {
  const parent = byId.get(shape.parentId);
  return parent?.typeName === "shape" ? pageTransform(byId, parent) : { x: 0, y: 0, rotation: 0 };
}
function pageTransform(byId, shape) {
  const outer = parentTransform(byId, shape);
  return { ...toPage(outer, shape), rotation: outer.rotation + shape.rotation };
}
// Stores a page transform in the shape's own x, y and rotation, relative to its parent.
function place(byId, shape, transform) {
  const outer = parentTransform(byId, shape);
  const offset = { x: transform.x - outer.x, y: transform.y - outer.y };
  Object.assign(shape, toPage({ x: 0, y: 0, rotation: -outer.rotation }, offset));
  shape.rotation = transform.rotation - outer.rotation;
}

const FONT_PX = { s: 18, m: 24, l: 36, xl: 44 }; // tldraw's FONT_SIZES (em) x 16

const boxOf = (points) => {
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
};

// The box a shape occupies in its own unrotated frame; tldraw keeps no single field for this.
function localBounds(shape) {
  const props = shape.props;
  const scale = props.scale ?? 1;
  if (shape.type === "geo") return { x: 0, y: 0, w: props.w, h: props.h + (props.growY ?? 0) };
  if (shape.type === "note")
    return { x: 0, y: 0, w: 200 * scale, h: (200 + (props.growY ?? 0)) * scale };
  if (shape.type === "text") {
    // Text height isn't stored; estimate from line count and font size.
    const lines = Math.max(1, plainText(props.richText).split("\n").length);
    return { x: 0, y: 0, w: props.w * scale, h: lines * FONT_PX[props.size] * 1.35 * scale };
  }
  if (shape.type === "draw") return boxOf(props.segments.flatMap((segment) => segment.points));
  if (shape.type === "line") return boxOf(Object.values(props.points));
  if (shape.type === "arrow") return boxOf([props.start, props.end]);
  if (typeof props.w === "number" && typeof props.h === "number")
    return { x: 0, y: 0, w: props.w, h: props.h };
  return { x: 0, y: 0, w: 0, h: 0 };
}

// Axis-aligned page-space box: map the local box's corners to the page, then re-bound. A group has
// no size of its own; its box is the union of its children's boxes.
function pageBounds(byId, shape) {
  if (shape.type === "group")
    return boxOf(
      [...byId.values()]
        .filter((record) => record.parentId === shape.id)
        .map((child) => pageBounds(byId, child))
        .flatMap((b) => [b, { x: b.x + b.w, y: b.y + b.h }]),
    );
  const b = localBounds(shape);
  const transform = pageTransform(byId, shape);
  const corners = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x, b.y + b.h],
    [b.x + b.w, b.y + b.h],
  ].map(([x, y]) => toPage(transform, { x, y }));
  return boxOf(corners);
}

function summarize(byId, shape) {
  const props = shape.props;
  const transform = pageTransform(byId, shape);
  const item = {
    id: shape.id,
    type: shape.type === "geo" ? (props.geo === "rectangle" ? "rect" : props.geo) : shape.type,
    x: transform.x,
    y: transform.y,
  };
  item.rotation = +((transform.rotation * 180) / Math.PI).toFixed(3);
  item.opacity = shape.opacity;
  if (props.size !== undefined) item.weight = props.size;
  if (props.w !== undefined) item.w = props.w;
  if (props.h !== undefined) item.h = props.h;
  if (props.richText) item.text = plainText(props.richText);
  if (shape.type === "mermaid") item.text = props.source;
  for (const key of ["color", "fill", "dash", "font"])
    if (props[key] !== undefined) item[key] = props[key];
  if (shape.type === "line" || shape.type === "arrow") {
    const [start, end] = endpoints(shape).map((p) => toPage(transform, p));
    item.start = start;
    item.end = end;
  }
  return item;
}

function newShape(type, x, y) {
  const base = {
    id: `shape:wb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    typeName: "shape",
    parentId: "page:page",
    index: "a1",
    x,
    y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
  };
  if (type === "text")
    return {
      ...base,
      type: "text",
      props: {
        color: "black",
        size: "m",
        w: 320,
        font: "draw",
        textAlign: "start",
        autoSize: true,
        scale: 1,
        richText: richText(""),
      },
    };
  if (type === "rect" || type === "ellipse")
    return {
      ...base,
      type: "geo",
      props: {
        geo: type === "rect" ? "rectangle" : "ellipse",
        dash: "draw",
        url: "",
        w: 200,
        h: 120,
        growY: 0,
        scale: 1,
        flipX: false,
        flipY: false,
        labelColor: "black",
        color: "black",
        fill: "none",
        size: "m",
        font: "draw",
        align: "middle",
        verticalAlign: "middle",
        richText: richText(""),
      },
    };
  if (type === "line")
    return {
      ...base,
      type: "line",
      props: {
        color: "black",
        dash: "draw",
        size: "m",
        spline: "line",
        scale: 1,
        points: {
          a1: { id: "a1", index: "a1", x: 0, y: 0 },
          a2: { id: "a2", index: "a2", x: 100, y: 0 },
        },
      },
    };
  if (type === "note")
    return {
      ...base,
      type: "note",
      props: {
        color: "black",
        labelColor: "black",
        size: "m",
        font: "draw",
        fontSizeAdjustment: null,
        align: "middle",
        verticalAlign: "middle",
        growY: 0,
        url: "",
        richText: richText(""),
        scale: 1,
        textLastEditedBy: null,
      },
    };
  if (type === "arrow")
    return {
      ...base,
      type: "arrow",
      props: {
        kind: "arc",
        labelColor: "black",
        color: "black",
        fill: "none",
        dash: "draw",
        size: "m",
        arrowheadStart: "none",
        arrowheadEnd: "arrow",
        font: "draw",
        start: { x: 0, y: 0 },
        end: { x: 100, y: 0 },
        bend: 0,
        richText: richText(""),
        labelPosition: 0.5,
        scale: 1,
        elbowMidPoint: 0.5,
      },
    };
  if (type === "mermaid") return { ...base, type: "mermaid", props: { source: "", w: 1, h: 1 } };
  return fail(`unknown --type ${type}`);
}

// Rewrites a line or arrow and its page transform so its endpoints sit at the given page points.
function setEndpoints(shape, transform, start, end) {
  transform.x = start.x;
  transform.y = start.y;
  // Turning the page-space end vector by the negated rotation puts it back into the shape's frame.
  const relative = toPage(
    { x: 0, y: 0, rotation: -transform.rotation },
    { x: end.x - start.x, y: end.y - start.y },
  );
  if (shape.type === "arrow") {
    shape.props.start = { x: 0, y: 0 };
    shape.props.end = relative;
    return;
  }
  const points = linePoints(shape);
  points[0].x = 0;
  points[0].y = 0;
  points.at(-1).x = relative.x;
  points.at(-1).y = relative.y;
}

// A mermaid shape takes its source from --text and its width from --size w; the height always
// follows the diagram's aspect ratio, which only rendering the source in a browser reveals.
async function editMermaid(shape, isNew) {
  for (const flag of ["color", "fill", "dash", "weight", "font"])
    if (flags[flag] !== undefined) fail(`--${flag} does not apply to a mermaid shape`);
  if (isNew && flags.text === undefined)
    fail('a mermaid shape needs its source: --text="$(cat chart.mmd)"');
  let w = shape.props.w;
  let aspect = { w: shape.props.w, h: shape.props.h };
  if (flags.size !== undefined) {
    w = Number(flags.size);
    if (!Number.isFinite(w) || w <= 0)
      fail(
        "--size expects one width for a mermaid shape, for example --size 480; the height follows the diagram",
      );
  }
  if (flags.text !== undefined) {
    const drawn = await withPage(`${web}/mermaid.html`, async (page) => {
      await page.waitForFunction(() => window.wbMermaid);
      return page.evaluate((source) => window.wbMermaid(source), flags.text);
    });
    if (!drawn.ok) fail(`mermaid: ${drawn.error}`);
    shape.props.source = flags.text;
    aspect = drawn;
    if (isNew && flags.size === undefined) w = drawn.w;
  }
  shape.props.w = w;
  shape.props.h = (w * aspect.h) / aspect.w;
}

async function write() {
  const board = await loadBoard();
  const byId = new Map(board.map((record) => [record.id, record]));
  let shape;
  if (flags.id) {
    if (flags.type) fail("--type cannot be changed on an existing shape");
    const existing = board.find((record) => record.id === flags.id);
    if (!existing) fail(`no shape ${flags.id} in room ${room}`);
    shape = structuredClone(existing);
  } else {
    if (!flags.at) fail("--at x,y is required when creating a shape");
    const [x, y] = point(flags.at, "at");
    shape = newShape(flags.type ?? "text", x, y);
  }
  const transform = pageTransform(byId, shape);
  if (!flags.id || flags.page !== undefined) shape.parentId = pageOf(board, flags.page).id;
  if (flags.rotate !== undefined) transform.rotation = (Number(flags.rotate) * Math.PI) / 180;
  const isSegment = shape.type === "line" || shape.type === "arrow";
  if (isSegment && (flags.at || flags.to)) {
    const [start, end] = endpoints(shape).map((p) => toPage(transform, p));
    if (flags.at) {
      const [x, y] = point(flags.at, "at");
      start.x = x;
      start.y = y;
    }
    if (flags.to) {
      const [x, y] = point(flags.to, "to");
      end.x = x;
      end.y = y;
    }
    setEndpoints(shape, transform, start, end);
  } else if (flags.id && flags.at) {
    const [x, y] = point(flags.at, "at");
    transform.x = x;
    transform.y = y;
  }
  place(byId, shape, transform);
  if (shape.type === "mermaid") await editMermaid(shape, !flags.id);
  else {
    if (flags.text !== undefined) shape.props.richText = richText(flags.text);
    if (flags.size && shape.type === "text") {
      // A fixed width makes the text wrap; tldraw otherwise sizes the box to its content.
      const w = Number(flags.size);
      if (!Number.isFinite(w) || w <= 0)
        fail("--size expects one width for a text shape, for example --size 240");
      shape.props.w = w;
      shape.props.autoSize = false;
    } else if (flags.size) {
      if (!("w" in shape.props) || !("h" in shape.props))
        fail(`--size does not apply to a ${shape.type} shape`);
      const [w, h] = point(flags.size, "size");
      shape.props.w = w;
      shape.props.h = h;
    }
    for (const [flag, key] of [
      ["color", "color"],
      ["fill", "fill"],
      ["dash", "dash"],
      ["weight", "size"],
      ["font", "font"],
    ]) {
      if (flags[flag] === undefined) continue;
      if (!(key in shape.props)) fail(`--${flag} does not apply to a ${shape.type} shape`);
      shape.props[key] = flags[flag];
    }
  }
  if (flags.opacity !== undefined) shape.opacity = Number(flags.opacity);
  // Fractional indices order shapes on the page; step past the current extreme to restack.
  const indexes = board
    .filter((record) => record.typeName === "shape" && record.id !== shape.id)
    .map((record) => record.index)
    .sort();
  if (!flags.id) shape.index = getIndexAbove(indexes.at(-1));
  if (flags.order === "front") shape.index = getIndexAbove(indexes.at(-1));
  else if (flags.order === "back") shape.index = getIndexBelow(indexes[0]);
  else if (flags.order) fail("--order expects front or back");
  await editBoard([shape], []);
  const after = new Map((await loadBoard()).map((record) => [record.id, record]));
  const stored = after.get(shape.id);
  const at = pageTransform(after, stored);
  return { id: stored.id, x: at.x, y: at.y, w: stored.props.w, h: stored.props.h };
}

async function read() {
  const board = await loadBoard();
  const byId = new Map(board.map((record) => [record.id, record]));
  const shapes = board.filter((record) => record.typeName === "shape");
  const r = positionals[1] && region(positionals[1]);
  // Without a region or --page, every page's shapes are listed; a region always lies on one page.
  const page = (r || flags.page !== undefined) && pageOf(board, r?.page ?? flags.page).id;
  return shapes
    .filter((shape) => {
      const on = pageIdOf(byId, shape);
      if (!on || (page && on !== page)) return false;
      if (!r) return true;
      const a = pageBounds(byId, shape);
      return a.x <= r.x + r.w && a.x + a.w >= r.x && a.y <= r.y + r.h && a.y + a.h >= r.y;
    })
    .map((shape) => ({ ...summarize(byId, shape), page: byId.get(pageIdOf(byId, shape)).name }));
}

async function pages() {
  const board = await loadBoard();
  const byId = new Map(board.map((record) => [record.id, record]));
  const shapes = board.filter((record) => record.typeName === "shape");
  return pagesOf(board).map((page, i) => ({
    page: i + 1,
    id: page.id,
    name: page.name,
    shapes: shapes.filter((shape) => pageIdOf(byId, shape) === page.id).length,
  }));
}

// Opens url in headless Chrome, runs fn on the page, and closes the browser.
async function withPage(url, fn) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: "/opt/google/chrome/chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function shot() {
  const theme = flags.theme ?? "dark";
  if (theme !== "light" && theme !== "dark") fail("--theme expects light or dark");
  const out = flags.out ?? `${NodeOS.tmpdir()}/wb-shot-${Date.now()}.png`;
  const arg = positionals[1];
  const box = arg && region(arg);
  const pageId = pageOf(await loadBoard(), box?.page ?? flags.page).id;
  const request = box ? `${box.x},${box.y},${box.w},${box.h}` : "fit";
  const dataUrl = await withPage(
    `${web}/?room=${room}&export=${request}&page=${encodeURIComponent(pageId)}&theme=${theme}`,
    async (page) => {
      await page.waitForFunction(() => window.wbExport);
      return page.evaluate(() => window.wbExport);
    },
  );
  NodeFS.writeFileSync(out, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
  return { file: out };
}

// Deleting a group or frame deletes the shapes inside it, and with them every binding that would
// otherwise point at a missing shape.
async function remove(ids) {
  const board = await loadBoard();
  const byId = new Map(board.map((record) => [record.id, record]));
  const inside = (id) =>
    ids.includes(id) || (byId.get(id)?.typeName === "shape" && inside(byId.get(id).parentId));
  const shapes = new Set([
    ...ids,
    ...board.filter((record) => record.typeName === "shape" && inside(record.id)).map((r) => r.id),
  ]);
  const bindings = board
    .filter(
      (record) =>
        record.typeName === "binding" && (shapes.has(record.fromId) || shapes.has(record.toId)),
    )
    .map((record) => record.id);
  await editBoard([], [...shapes, ...bindings]);
  return { deleted: [...shapes] };
}

// Sends a raw {puts, deletes} body straight to the API, for records the high-level commands do not model.
async function writeRaw() {
  const body = JSON.parse(await NodeStreamConsumers.text(process.stdin));
  await editBoard(body.puts ?? [], body.deletes ?? []);
  return { ok: true, puts: (body.puts ?? []).length, deletes: (body.deletes ?? []).length };
}

const command = positionals[0];
const result =
  command === "read"
    ? await read()
    : command === "pages"
      ? await pages()
      : command === "read-raw"
        ? await loadBoard()
        : command === "write-raw"
          ? await writeRaw()
          : command === "write"
            ? await write()
            : command === "delete"
              ? await remove(positionals.slice(1))
              : command === "shot"
                ? await shot()
                : fail(`unknown command ${command ?? ""}\n${usage}`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
