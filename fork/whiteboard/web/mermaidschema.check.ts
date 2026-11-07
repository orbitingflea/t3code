// Checks how the sync server's schema treats the mermaid shape and older clients; run with `npm test`.
import * as NodeAssert from "node:assert/strict";
import * as SyncCore from "@tldraw/sync-core";
import { InMemorySyncStorage, TLSocketRoom, type RoomSnapshot } from "@tldraw/sync-core";
import { createTLSchema, type TLRecord } from "@tldraw/tlschema";
import { boardSchema } from "../server/schema";

// The package exports this at runtime but leaves it out of its public types.
const { getTlsyncProtocolVersion } = SyncCore as unknown as { getTlsyncProtocolVersion(): number };

let checked = 0;

const page = {
  id: "page:page",
  typeName: "page",
  name: "Page 1",
  index: "a1",
  meta: {},
};
const mermaid = (props: Record<string, unknown>) => ({
  id: "shape:m1",
  typeName: "shape",
  type: "mermaid",
  parentId: "page:page",
  index: "a1",
  x: 0,
  y: 0,
  rotation: 0,
  isLocked: false,
  opacity: 1,
  meta: {},
  props,
});
// The same call the server makes on every put of /api/board/edit.
const validate = (record: { typeName: string }) =>
  boardSchema.types[record.typeName as keyof typeof boardSchema.types].validate(record);

const rooms: Array<TLSocketRoom<TLRecord, undefined>> = [];
function room(snapshot?: RoomSnapshot) {
  const opened = new TLSocketRoom<TLRecord, undefined>({
    storage: new InMemorySyncStorage<TLRecord>({ snapshot }),
    schema: boardSchema,
  });
  rooms.push(opened);
  return opened;
}

// Connects a client that announces `schema` and reports how the server answered.
async function connect(target: TLSocketRoom<TLRecord, undefined>, schema: unknown) {
  const sent: Array<{ type: string }> = [];
  let closed: { code?: number; reason?: string } | null = null;
  target.handleSocketConnect({
    sessionId: "s1",
    socket: {
      readyState: 1,
      send: (message: string) => sent.push(JSON.parse(message)),
      close: (code?: number, reason?: string) => (closed = { code, reason }),
      addEventListener: () => {},
      removeEventListener: () => {},
    } as never,
  });
  target.handleSocketMessage(
    "s1",
    JSON.stringify({
      type: "connect",
      connectRequestId: "c1",
      schema,
      protocolVersion: getTlsyncProtocolVersion(),
      lastServerClock: 0,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { sent, closed: closed as { code?: number; reason?: string } | null };
}

{
  const old = await connect(room(), createTLSchema().serialize());
  NodeAssert.equal(
    old.closed?.reason,
    "CLIENT_TOO_OLD",
    "a client built before the mermaid shape is turned away as too old",
  );
  checked++;
}

{
  const current = await connect(room(), boardSchema.serialize());
  NodeAssert.equal(current.closed, null, "a client with the board schema stays connected");
  NodeAssert.ok(
    current.sent.some((message) => message.type === "connect"),
    "a client with the board schema gets the connect reply",
  );
  checked++;
}

{
  const before = createTLSchema();
  const snapshot = {
    clock: 1,
    documentClock: 1,
    documents: [
      {
        state: { id: "document:document", typeName: "document", gridSize: 10, name: "", meta: {} },
        lastChangedClock: 1,
      },
      { state: page, lastChangedClock: 1 },
    ],
    schema: before.serialize(),
    tombstones: {},
  } as unknown as RoomSnapshot;
  const loaded = room(snapshot)
    .getCurrentSnapshot()
    .documents.map((entry) => entry.state);
  NodeAssert.deepEqual(
    loaded.find((record) => record.id === "page:page"),
    page,
    "a room stored before the mermaid shape loads unchanged",
  );
  for (const record of loaded) validate(record);
  checked++;
}

{
  const good = mermaid({ source: "flowchart LR\n  A --> B", w: 200, h: 100 });
  NodeAssert.deepEqual(validate(good), good, "a complete mermaid record passes validation");
  for (const props of [
    { source: "flowchart LR\n  A --> B", h: 100 },
    { source: "flowchart LR\n  A --> B", w: -5, h: 100 },
    { source: "flowchart LR\n  A --> B", w: 0, h: 100 },
    { w: 200, h: 100 },
  ])
    NodeAssert.throws(
      () => validate(mermaid(props)),
      `mermaid props ${JSON.stringify(props)} fail validation`,
    );
  checked++;
}

rooms.forEach((opened) => opened.close());
console.log(`mermaidschema: ${checked} checks pass`);
