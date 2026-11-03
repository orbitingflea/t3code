import { expect, it } from "vite-plus/test";

import { previewControlLabel } from "./previewControlHolder";

const control = {
  canOperate: true,
  controller: "another-viewer",
  generation: 3,
  dialog: null,
  viewer: "77b0e1aa",
  holder: { viewer: "a3f9c2d1", attachedAt: null, connected: false },
} as const;

it("names the viewer that holds control", () => {
  expect(previewControlLabel(control)).toBe(
    "Another viewer has control (viewer a3f9c2d1, still connecting; this viewer is 77b0e1aa)",
  );
  expect(previewControlLabel({ ...control, controller: "you" })).toBe("You have control");
});
