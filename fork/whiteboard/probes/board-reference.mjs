import { chromium } from "playwright-core";

const baseUrl = process.env.WHITEBOARD_URL ?? "http://127.0.0.1:6061";
const screenshot = process.env.WHITEBOARD_PROBE_SCREENSHOT ?? "/tmp/whiteboard-board-reference.png";
const offscreenScreenshot =
  process.env.WHITEBOARD_PROBE_OFFSCREEN_SCREENSHOT ??
  "/tmp/whiteboard-board-reference-offscreen.png";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function angleDifference(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

const browser = await chromium.launch({
  executablePath: "/opt/google/chrome/chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(baseUrl);
  await page.waitForSelector(".tl-canvas");
  await page.waitForTimeout(800);

  const bridgeUrl = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => /\/web\/bridge\.ts(?:\?|$)/.test(name)),
  );
  assert(bridgeUrl, "The page did not load a bridge.ts module");

  const initial = await page.evaluate(() => {
    const board = document.querySelector(".tl-canvas")?.getBoundingClientRect();
    const shape = [...document.querySelectorAll(".tl-shape")].find(
      (element) =>
        getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 20,
    );
    if (!board || !shape) return null;
    const rect = shape.getBoundingClientRect();
    const transform = new DOMMatrixReadOnly(getComputedStyle(shape).transform);
    return {
      board: board.toJSON(),
      region: {
        x: Math.round(transform.e),
        y: Math.round(transform.f),
        w: Math.max(20, Math.round(rect.width)),
        h: Math.max(20, Math.round(rect.height)),
      },
      origin: { x: board.right - 70, y: board.top + 110 },
    };
  });
  assert(initial, "The board has no visible shape for the reference probe");

  const cameraBefore = await page.evaluate(() => ({
    canvas: getComputedStyle(document.querySelector(".tl-canvas")).transform,
    shapes: getComputedStyle(document.querySelector('.tl-shape[style*="display: block"]'))
      .transform,
  }));

  await page.evaluate(
    async ({ bridgeUrl, region, origin }) => {
      const bridge = await import(bridgeUrl);
      bridge.hoverRegion(`board://r/${region.x},${region.y},${region.w},${region.h}`, origin);
    },
    { bridgeUrl, region: initial.region, origin: initial.origin },
  );
  await page.locator(".region-mark.hover").waitFor({ state: "visible" });
  await page.locator(".region-arrow line").waitFor({ state: "attached" });

  const ordinary = await page.evaluate(() => {
    const mark = document.querySelector(".region-mark.hover");
    const arrow = document.querySelector(".region-arrow");
    const line = arrow?.querySelector("line");
    const ui = document.querySelector(".tlui-layout");
    return {
      mark: mark?.getBoundingClientRect().toJSON(),
      arrowCount: document.querySelectorAll(".region-arrow").length,
      from: line
        ? { x: Number(line.getAttribute("x1")), y: Number(line.getAttribute("y1")) }
        : null,
      parent: arrow?.parentElement?.tagName,
      position: arrow ? getComputedStyle(arrow).position : null,
      zIndex: arrow ? Number(getComputedStyle(arrow).zIndex) : 0,
      uiZIndex: ui ? Number(getComputedStyle(ui).zIndex) : 0,
    };
  });
  assert(ordinary.mark, "Ordinary hover did not highlight the target region");
  assert(
    ordinary.arrowCount === 1,
    `Ordinary hover rendered ${ordinary.arrowCount} arrows instead of one`,
  );
  assert(
    ordinary.from?.x === initial.origin.x && ordinary.from?.y === initial.origin.y,
    "The ordinary hover arrow did not start at the supplied origin",
  );
  assert(ordinary.parent === "BODY", "The reference overlay was not portaled to BODY");
  assert(ordinary.position === "fixed", "The reference overlay does not use fixed positioning");
  assert(
    ordinary.zIndex > ordinary.uiZIndex,
    `Reference overlay z-index ${ordinary.zIndex} is not above tldraw UI ${ordinary.uiZIndex}`,
  );
  await page.screenshot({ path: screenshot });

  const offscreen = {
    x: Math.round(initial.region.x + 5000),
    y: Math.round(initial.region.y + 3500),
    w: initial.region.w,
    h: initial.region.h,
  };
  await page.evaluate(
    async ({ bridgeUrl, offscreen, origin }) => {
      const bridge = await import(bridgeUrl);
      bridge.hoverRegion(
        `board://r/${offscreen.x},${offscreen.y},${offscreen.w},${offscreen.h}`,
        origin,
      );
    },
    { bridgeUrl, offscreen, origin: initial.origin },
  );
  await page.locator(".region-arrow-edge").waitFor({ state: "visible" });
  assert(
    (await page.locator(".region-mark").count()) === 0,
    "The highlight box remains visible for an offscreen target",
  );

  const edge = await page.evaluate(
    ({ initialRegion, initialMark, offscreen }) => {
      const group = document.querySelector(".region-arrow-edge");
      const arrow = group?.closest(".region-arrow");
      const board = document.querySelector(".tl-canvas")?.getBoundingClientRect();
      const transform = group?.getAttribute("transform") ?? "";
      const match = /translate\(([-\d.]+) ([-\d.]+)\) rotate\(([-\d.]+)\)/.exec(transform);
      if (!group || !arrow || !board || !match) return null;
      const x = Number(match[1]);
      const y = Number(match[2]);
      const rotation = Number(match[3]);
      const zoom = initialMark.width / initialRegion.w;
      const targetCenter = {
        x: initialMark.x + (offscreen.x - initialRegion.x + offscreen.w / 2) * zoom,
        y: initialMark.y + (offscreen.y - initialRegion.y + offscreen.h / 2) * zoom,
      };
      const expected = (Math.atan2(targetCenter.y - y, targetCenter.x - x) * 180) / Math.PI;
      const box = group.getBoundingClientRect();
      const circle = group.querySelector("circle");
      return {
        box: box.toJSON(),
        radius: Number(circle?.getAttribute("r")),
        x,
        y,
        rotation,
        expected,
        board: board.toJSON(),
        zIndex: Number(getComputedStyle(arrow).zIndex),
        uiZIndex: Number(getComputedStyle(document.querySelector(".tlui-layout")).zIndex),
      };
    },
    { initialRegion: initial.region, initialMark: ordinary.mark, offscreen },
  );
  assert(edge, "The offscreen edge arrow could not be inspected");
  assert(
    edge.x >= edge.board.left + 42 && edge.x <= edge.board.right - 42,
    "The edge arrow center is not clamped horizontally inside the board",
  );
  assert(
    edge.y >= edge.board.top + 42 && edge.y <= edge.board.bottom - 42,
    "The edge arrow center is not clamped vertically inside the board",
  );
  assert(
    edge.radius === 30 && edge.box.width >= 58 && edge.box.height >= 58,
    `Incorrect edge arrow size: r=${edge.radius}, ${edge.box.width}x${edge.box.height}`,
  );
  assert(
    edge.box.x >= edge.board.left &&
      edge.box.y >= edge.board.top &&
      edge.box.right <= edge.board.right &&
      edge.box.bottom <= edge.board.bottom,
    "The edge arrow is not fully contained within the board",
  );
  assert(
    angleDifference(edge.rotation, edge.expected) < 3,
    `Edge arrow direction differs by ${angleDifference(edge.rotation, edge.expected)} degrees`,
  );
  assert(edge.zIndex > edge.uiZIndex, "The offscreen arrow is not above the tldraw UI");

  const cameraAfter = await page.evaluate(() => ({
    canvas: getComputedStyle(document.querySelector(".tl-canvas")).transform,
    shapes: getComputedStyle(document.querySelector('.tl-shape[style*="display: block"]'))
      .transform,
  }));
  assert(
    JSON.stringify(cameraAfter) === JSON.stringify(cameraBefore),
    "The camera moved during hover",
  );
  await page.screenshot({ path: offscreenScreenshot });

  await page.evaluate(async (bridgeUrl) => {
    const bridge = await import(bridgeUrl);
    bridge.hoverRegion(null);
  }, bridgeUrl);
  await page.locator(".region-arrow").waitFor({ state: "detached" });
  assert(
    (await page.locator(".region-mark").count()) === 0,
    "The overlay remains after hover is cleared",
  );

  console.log(
    JSON.stringify({ ok: true, ordinary, edge, screenshot, offscreenScreenshot }, null, 2),
  );
} finally {
  await browser.close();
}
