# Raw record access

The raw commands read and write tldraw records directly.

```
wb read-raw
wb write-raw   # reads {"puts": [...], "deletes": [...]} from stdin
```

`read-raw` prints every stored record in the room, including the document and page records. Shapes are the records whose `typeName` is `"shape"`.

`write-raw` reads `puts` and `deletes` from stdin. Each entry of `puts` is a complete tldraw record. Each entry of `deletes` is a record id. The server validates every put, then applies the batch atomically. If any put fails validation, `wb` prints tldraw's error on stderr and exits 1, and the room is unchanged.

To change anything `wb read` and `wb write` leave out: read the record with `read-raw`, edit it, and send it back with `write-raw`. For a new record, copy the field layout from a record of the same kind, or from the tldraw schema. Use `shape:wb-<unique-value>` as the id of a new shape.

```bash
wb write-raw <<'JSON'
{
  "puts": [{
    "id": "shape:wb-text-001",
    "typeName": "shape",
    "type": "text",
    "parentId": "page:page",
    "index": "a1",
    "x": 120,
    "y": 120,
    "rotation": 0,
    "isLocked": false,
    "opacity": 1,
    "meta": {},
    "props": {
      "color": "black",
      "size": "m",
      "w": 320,
      "font": "draw",
      "textAlign": "start",
      "autoSize": true,
      "scale": 1,
      "richText": {
        "type": "doc",
        "attrs": {"dir": "auto"},
        "content": [{
          "type": "paragraph",
          "attrs": {"dir": "auto"},
          "content": [{"type": "text", "text": "Text written by an agent"}]
        }]
      }
    }
  }],
  "deletes": []
}
JSON
```
