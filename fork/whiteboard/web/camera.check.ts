// Hand-written input/output pairs for camera, decided before running; run with `npm test`.
import * as NodeAssert from "node:assert/strict";
import { cameraAt, cameraForRegion, viewCenter } from "./camera";

const view = { w: 800, h: 600 };

let checked = 0;

// (a) A region that fits at 100% is shown at 100%, centered.
{
  const region = { x: 100, y: 100, w: 200, h: 100 };
  const camera = cameraForRegion(region, view, 80);
  NodeAssert.equal(camera.z, 1, "fitting region is shown at 100%");
  NodeAssert.deepEqual(viewCenter(camera, view), { x: 200, y: 150 }, "fitting region is centered");
  checked++;
}

// (b) A region wider than the panel yields the fit zoom and the region center at the panel center.
{
  const region = { x: 0, y: 0, w: 4000, h: 100 };
  const fitZoom = (view.w - 160) / region.w;
  const camera = cameraForRegion(region, view, 80);
  NodeAssert.equal(camera.z, fitZoom, "oversized region zooms out to fit");
  NodeAssert.deepEqual(
    viewCenter(camera, view),
    { x: 2000, y: 50 },
    "oversized region is still centered",
  );
  checked++;
}

// (c) A tiny region is never blown up past 100%.
{
  const tinyRegion = { x: 10, y: 10, w: 5, h: 5 };
  const camera = cameraForRegion(tinyRegion, view, 80);
  NodeAssert.equal(camera.z, 1, "a tiny region is shown at 100%, not filling the panel");
  NodeAssert.deepEqual(
    viewCenter(camera, view),
    { x: 12.5, y: 12.5 },
    "a tiny region is still centered",
  );
  checked++;
}

// viewCenter(cameraAt(p, z, view), view) recovers p.
{
  const p = { x: 321, y: -45 };
  const z = 1.7;
  NodeAssert.deepEqual(
    viewCenter(cameraAt(p, z, view), view),
    p,
    "cameraAt and viewCenter are inverses",
  );
  checked++;
}

console.log(`camera: ${checked} checks pass`);
