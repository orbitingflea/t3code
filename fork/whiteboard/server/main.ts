// Runs the multi-room sync service and exposes room-addressable board HTTP endpoints.
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";
import { InMemorySyncStorage, TLSocketRoom, type RoomSnapshot } from "@tldraw/sync-core";
import { createTLSchema, type TLRecord } from "@tldraw/tlschema";
import { WebSocketServer } from "ws";
import { config } from "./config.mjs";
import { normalizeMath } from "../web/mathsplit";
import { boardRoom } from "../web/room.mjs";

const PERSIST_INTERVAL_MS = 30_000;
const schema = createTLSchema();
type ActiveRoom = {
  room: TLSocketRoom<TLRecord, undefined>;
  storage: InMemorySyncStorage<TLRecord>;
  save: Promise<void>;
  snapshot: string;
};
const rooms = new Map<string, Promise<ActiveRoom>>();

async function openRoom(name: string): Promise<ActiveRoom> {
  const slug = boardRoom(name);
  let pending = rooms.get(slug);
  if (!pending) {
    pending = (async () => {
      const snapshot = `${config.dataDir}/room-${slug}.json`;
      let initial: RoomSnapshot | undefined;
      try {
        initial = JSON.parse(await readFile(snapshot, "utf8")) as RoomSnapshot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const storage = new InMemorySyncStorage<TLRecord>({ snapshot: initial });
      return {
        storage,
        room: new TLSocketRoom<TLRecord, undefined>({ storage, schema }),
        save: Promise.resolve(),
        snapshot,
      };
    })();
    rooms.set(slug, pending);
  }
  return pending;
}

function persist(active: ActiveRoom) {
  active.save = active.save
    .catch(() => undefined)
    .then(async () => {
      const temp = `${active.snapshot}.tmp`;
      await writeFile(temp, JSON.stringify(active.storage.getSnapshot()));
      await rename(temp, active.snapshot);
    });
  return active.save;
}

await mkdir(config.dataDir, { recursive: true });
setInterval(
  () =>
    void Promise.all([...rooms.values()].map(async (room) => persist(await room))).catch(
      console.error,
    ),
  PERSIST_INTERVAL_MS,
).unref();

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const active = await openRoom(url.searchParams.get("room") ?? "main");
    if (req.method === "GET" && url.pathname === "/api/board")
      return json(
        res,
        200,
        active.room.getCurrentSnapshot().documents.map((entry) => entry.state),
      );
    if (req.method !== "POST" || url.pathname !== "/api/board/edit")
      return json(res, 404, { error: "not found" });
    const body = JSON.parse(await text(req)) as {
      puts: Array<{ typeName?: string; props?: { richText?: unknown } }>;
      deletes: string[];
    };
    const puts = body.puts.map((record) => {
      const candidate = structuredClone(record);
      if (candidate.typeName === "shape" && candidate.props?.richText)
        candidate.props.richText = normalizeMath(candidate.props.richText);
      const recordType =
        candidate.typeName && schema.types[candidate.typeName as keyof typeof schema.types];
      if (!recordType) throw new Error(`unknown record type: ${String(candidate.typeName)}`);
      return recordType.validate(candidate) as TLRecord;
    });
    await active.room.updateStore((store) => {
      for (const record of puts) store.put(record);
      for (const id of body.deletes) store.delete(id);
    });
    await persist(active);
    json(res, 200, { ok: true });
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/connect/")) return socket.destroy();
  const roomName = url.pathname.slice("/connect/".length);
  void openRoom(roomName)
    .then((active) =>
      sockets.handleUpgrade(req, socket, head, (ws) =>
        active.room.handleSocketConnect({
          sessionId: url.searchParams.get("sessionId") ?? randomUUID(),
          socket: ws,
        }),
      ),
    )
    .catch(() => socket.destroy());
});

async function stop() {
  const active = await Promise.all(rooms.values());
  await Promise.all(active.map(persist));
  active.forEach(({ room }) => room.close());
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
server.listen(config.port, config.host, () =>
  console.log(`whiteboard sync listening on ${config.host}:${config.port}`),
);
