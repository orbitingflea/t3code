import { expect, it } from "vite-plus/test";
import { decodeControlHolder } from "./previewControlHolder.ts";

it("reads who holds control and drops what an upstream server does not send", () => {
  const holder = { viewer: "a3f9c2d1", attachedAt: 1_700_000_000_000, connected: false };
  expect(decodeControlHolder({ viewer: "77b0e1aa", holder })).toEqual({
    viewer: "77b0e1aa",
    holder,
  });
  expect(decodeControlHolder({ holder: null })).toEqual({});
  expect(decodeControlHolder({ viewer: 7, holder: { viewer: "a3f9c2d1" } })).toEqual({});
});
