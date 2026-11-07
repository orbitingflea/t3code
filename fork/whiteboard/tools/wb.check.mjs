// Runs the real wb CLI against a real sync server in a throwaway HOME; run with `npm test`.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const root = NodePath.dirname(NodePath.dirname(new URL(import.meta.url).pathname));
const home = NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/wb-check-`);
const port = await new Promise((resolve) => {
  const probe = NodeNet.createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
NodeFS.mkdirSync(`${home}/.whiteboard`);
NodeFS.writeFileSync(
  `${home}/.whiteboard/config.json`,
  JSON.stringify({ port, dataDir: `${home}/.whiteboard/data` }),
);
const env = { ...process.env, HOME: home };
delete env.WB_CHAT_PID;

const server = NodeChildProcess.spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "inherit"],
});
const stopped = new Promise((resolve) => server.once("exit", resolve));
await new Promise((resolve, reject) => {
  server.stdout.on("data", (chunk) => String(chunk).includes("listening") && resolve());
  server.once("exit", (code) => reject(new Error(`sync server exited with ${code}`)));
});

function wb(args, input) {
  const run = NodeChildProcess.spawnSync(
    process.execPath,
    ["tools/wb.mjs", ...args, "--room", "test"],
    { cwd: root, env, input, encoding: "utf8" },
  );
  return {
    status: run.status,
    stderr: run.stderr,
    json: run.status === 0 ? JSON.parse(run.stdout) : undefined,
  };
}
const ok = (args, input) => {
  const run = wb(args, input);
  NodeAssert.equal(run.status, 0, `wb ${args.join(" ")} exits 0: ${run.stderr}`);
  return run.json;
};

const shape = (id, type, parentId, x, y, props) => ({
  id: `shape:${id}`,
  typeName: "shape",
  type,
  parentId,
  index: "a1",
  x,
  y,
  rotation: 0,
  isLocked: false,
  opacity: 1,
  meta: {},
  props,
});
const doc = { type: "doc", attrs: { dir: "auto" }, content: [] };
const geo = (w, h) => ({
  geo: "rectangle",
  dash: "draw",
  url: "",
  w,
  h,
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
  richText: doc,
});
const note = {
  color: "yellow",
  labelColor: "black",
  size: "m",
  font: "draw",
  fontSizeAdjustment: null,
  align: "middle",
  verticalAlign: "middle",
  growY: 0,
  url: "",
  richText: doc,
  scale: 1,
  textLastEditedBy: null,
};
const arrow = {
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
  richText: doc,
  labelPosition: 0.5,
  scale: 1,
  elbowMidPoint: 0.5,
};
const binding = (arrowId, shapeId) => ({
  id: `binding:${arrowId}`,
  typeName: "binding",
  type: "arrow",
  fromId: `shape:${arrowId}`,
  toId: `shape:${shapeId}`,
  props: {
    terminal: "end",
    normalizedAnchor: { x: 0.5, y: 0.5 },
    isExact: false,
    isPrecise: false,
    snap: "none",
  },
  meta: {},
});
const frame = (w, h) => ({ w, h, name: "Frame", color: "black" });

let checked = 0;
try {
  // Deleting a group or frame takes its children and the arrow bindings to them along.
  {
    ok(
      ["write-raw"],
      JSON.stringify({
        puts: [
          shape("group", "group", "page:page", 0, 0, {}),
          shape("a", "geo", "shape:group", 0, 0, geo(100, 100)),
          shape("b", "geo", "shape:group", 300, 0, geo(100, 100)),
          shape("link", "arrow", "shape:group", 100, 50, { ...arrow, end: { x: 200, y: 0 } }),
          shape("frame", "frame", "page:page", 0, 400, frame(400, 300)),
          shape("framed", "note", "shape:frame", 20, 20, note),
          shape("keep", "geo", "page:page", 0, 900, geo(100, 100)),
          shape("outside", "arrow", "page:page", 0, 800, arrow),
          binding("link", "b"),
          binding("outside", "a"),
        ],
      }),
    );
    const gone = ["a", "b", "frame", "framed", "group", "link"].map((id) => `shape:${id}`);
    const { deleted } = ok(["delete", "shape:group", "shape:frame"]);
    const left = ok(["read-raw"]);
    NodeAssert.deepEqual(
      left.filter((record) => gone.includes(record.id)).map((record) => record.id),
      [],
      "no deleted container or child is left",
    );
    NodeAssert.deepEqual(
      left.filter((record) => record.typeName === "binding"),
      [],
      "no binding to a deleted shape is left",
    );
    NodeAssert.deepEqual(
      ok(["read"])
        .map((item) => item.id)
        .sort(),
      ["shape:keep", "shape:outside"],
      "wb read lists the shapes outside the deleted containers, the arrow bound into one too",
    );
    NodeAssert.equal(ok(["pages"])[0].shapes, 2, "wb pages counts the remaining shapes");
    NodeAssert.deepEqual(deleted.sort(), gone, "wb delete names every shape it deleted");
    checked++;
  }

  // A room that already holds a shape whose parent is gone still reads.
  {
    ok(
      ["write-raw"],
      JSON.stringify({ puts: [shape("orphan", "note", "shape:missing", 0, 0, note)] }),
    );
    NodeAssert.deepEqual(
      ok(["read"])
        .map((item) => item.id)
        .sort(),
      ["shape:keep", "shape:outside"],
      "wb read skips the orphan",
    );
    NodeAssert.equal(ok(["pages"])[0].shapes, 2, "wb pages skips the orphan");
    ok(["delete", "shape:orphan"]);
    checked++;
  }

  // Shapes inside a group or a rotated frame read and write in page coordinates.
  {
    ok(
      ["write-raw"],
      JSON.stringify({
        puts: [
          shape("g", "group", "page:page", 500, 300, {}),
          shape("r", "geo", "shape:g", 10, 20, geo(200, 120)),
          shape("e", "geo", "shape:g", 300, 0, geo(100, 100)),
          { ...shape("f", "frame", "page:page", 1000, 0, frame(300, 400)), rotation: Math.PI / 2 },
          shape("n", "note", "shape:f", 20, 10, note),
          shape("fa", "arrow", "shape:f", 100, 300, { ...arrow, end: { x: 50, y: 0 } }),
        ],
      }),
    );
    const exact = (n) => Math.round(n * 1e6) / 1e6 + 0;
    const item = (id) => {
      const found = ok(["read"]).find((entry) => entry.id === `shape:${id}`);
      return {
        x: exact(found.x),
        y: exact(found.y),
        rotation: found.rotation,
        ...(found.start && {
          start: { x: exact(found.start.x), y: exact(found.start.y) },
          end: { x: exact(found.end.x), y: exact(found.end.y) },
        }),
      };
    };
    const hits = (region) =>
      ok(["read", region])
        .map((entry) => entry.id)
        .sort();

    NodeAssert.deepEqual(
      item("r"),
      { x: 510, y: 320, rotation: 0 },
      "group child at page position",
    );
    NodeAssert.deepEqual(
      item("n"),
      { x: 990, y: 20, rotation: 90 },
      "rotated frame child at page position and rotation",
    );
    NodeAssert.deepEqual(
      item("fa"),
      { x: 700, y: 100, rotation: 90, start: { x: 700, y: 100 }, end: { x: 700, y: 150 } },
      "rotated frame arrow endpoints in page coordinates",
    );
    NodeAssert.deepEqual(hits("600,380,10,10"), ["shape:g", "shape:r"], "region finds group child");
    NodeAssert.deepEqual(
      hits("850,420,10,10"),
      ["shape:g"],
      "group box is the union of its children's boxes",
    );
    NodeAssert.deepEqual(
      hits("880,100,10,10"),
      ["shape:f", "shape:n"],
      "region finds rotated frame child",
    );
    NodeAssert.deepEqual(
      hits("100,100,10,10"),
      [],
      "region at a child's local position finds nothing",
    );

    NodeAssert.deepEqual(
      ok(["write", "--id", "shape:r", "--at", "600,350"]),
      { id: "shape:r", x: 600, y: 350, w: 200, h: 120 },
      "write prints the page position it was given",
    );
    NodeAssert.deepEqual(
      item("r"),
      { x: 600, y: 350, rotation: 0 },
      "group child moved in page coordinates",
    );
    ok(["write", "--id", "shape:n", "--at", "900,50", "--rotate", "45"]);
    NodeAssert.deepEqual(
      item("n"),
      { x: 900, y: 50, rotation: 45 },
      "rotated frame child moved and turned in page coordinates",
    );
    ok(["write", "--id", "shape:fa", "--at", "650,100", "--to", "650,200"]);
    NodeAssert.deepEqual(
      item("fa"),
      { x: 650, y: 100, rotation: 90, start: { x: 650, y: 100 }, end: { x: 650, y: 200 } },
      "rotated frame arrow endpoints set in page coordinates",
    );
    checked++;
  }
} finally {
  server.kill("SIGTERM");
  await stopped;
  NodeFS.rmSync(home, { recursive: true, force: true });
}

console.log(`wb: ${checked} checks pass`);
