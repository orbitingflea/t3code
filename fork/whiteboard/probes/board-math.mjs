import { chromium } from "playwright-core";

const baseUrl = process.env.WHITEBOARD_URL ?? "http://127.0.0.1:6061";
const apiUrl = process.env.WHITEBOARD_API_URL ?? "http://127.0.0.1:6060";
const screenshot = process.env.WHITEBOARD_PROBE_SCREENSHOT ?? "/tmp/whiteboard-board-math.png";
const latex = String.raw`\omega < 2.373`;
const zooms = [
  { label: "90%", deltas: [100] },
  { label: "51%", deltas: [100, 100, 100, 100, 20, 10, 5, -2] },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function emptyPoints(page) {
  return page.evaluate(() => {
    const board = document.querySelector(".tl-canvas")?.getBoundingClientRect();
    if (!board) return [];
    const points = [];
    for (let y = 150; y < board.height - 150; y += 70)
      for (let x = 150; x < board.width - 150; x += 90) {
        if (
          !document
            .elementsFromPoint(board.x + x, board.y + y)
            .some((element) => element.closest(".tl-shape"))
        )
          points.push({ x: board.x + x, y: board.y + y });
      }
    return points;
  });
}

async function startText(page) {
  for (const point of await emptyPoints(page)) {
    await page.getByRole("button", { name: /^Text/ }).click();
    await page.mouse.click(point.x, point.y);
    if (await page.locator('[contenteditable="true"]').count()) return point;
  }
  throw new Error("No empty board position is available for text input");
}

async function applyZoom(page, zoom) {
  await page.mouse.move(500, 400);
  for (const delta of zoom.deltas) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(30);
  }
  assert(
    (await page.getByRole("button", { name: /^Zoom/ }).getAttribute("aria-label")) ===
      `Zoom — ${zoom.label}`,
    `Failed to reach ${zoom.label} zoom`,
  );
}

async function inspectFormula(locator) {
  await locator.waitFor({ state: "visible" });
  return locator.evaluate((element) => {
    const shape = element.closest(".tl-shape");
    return {
      hasKatex: Boolean(element.querySelector(".katex")),
      visibleText: element.innerText,
      lineCount: element.getClientRects().length,
      width: element.getBoundingClientRect().width,
      katexWidth: element.querySelector(".katex")?.getBoundingClientRect().width ?? 0,
      shapeWidth: shape?.getBoundingClientRect().width ?? 0,
    };
  });
}

const browser = await chromium.launch({
  executablePath: "/opt/google/chrome/chrome",
  headless: true,
  args: ["--no-sandbox"],
});

try {
  const startup = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let startupError;
  startup.on("pageerror", (error) => {
    if (/Adding different instances of a keyed plugin/.test(error.message))
      startupError = error.stack;
  });
  startup.on("console", (message) => {
    if (/Adding different instances of a keyed plugin/.test(message.text()))
      startupError = message.text();
  });
  await startup.goto(baseUrl, { waitUntil: "commit" });
  await startup.waitForSelector(".tlui-layout", { state: "visible" });
  const [startupPoint] = await emptyPoints(startup);
  assert(startupPoint, "No empty board position is available after a hard reload");
  await startup.mouse.dblclick(startupPoint.x, startupPoint.y, { delay: 15 });
  await startup.locator('[contenteditable="true"]').waitFor({ state: "visible" });
  assert(!startupError, `The first double-click after a hard reload failed: ${startupError}`);
  await startup.close();

  const results = [];
  for (const zoom of zooms) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(baseUrl);
    await page.waitForSelector(".tl-canvas");
    await page.waitForTimeout(800);
    const existingIds = (
      await fetch(`${apiUrl}/api/board`).then((response) => response.json())
    ).map((item) => item.id);
    await applyZoom(page, zoom);
    await startText(page);
    await page.keyboard.insertText(`$${latex}`);
    await page.keyboard.insertText("$");

    const editingFormula = page.locator("math-inline").last();
    await editingFormula.waitFor({ state: "visible" });
    const shapeId = await editingFormula.evaluate((element) =>
      element.closest(".tl-shape")?.getAttribute("data-shape-id"),
    );
    assert(
      shapeId && !existingIds.includes(shapeId),
      `${zoom.label}: no new formula text shape was created`,
    );
    const editing = await inspectFormula(editingFormula);
    assert(editing.hasKatex, `${zoom.label}: the editing formula did not render as KaTeX`);
    assert(
      editing.lineCount === 1,
      `${zoom.label}: the editing formula uses ${editing.lineCount} lines instead of one`,
    );
    assert(
      Math.abs(editing.width - editing.katexWidth) <= 1,
      `${zoom.label}: the editing formula and KaTeX widths differ`,
    );

    await page.keyboard.press("Escape");
    const staticFormula = page.locator(
      `[data-shape-id="${shapeId}"] span[data-type="inline-math"]`,
    );
    const blurred = await inspectFormula(staticFormula);
    assert(
      !blurred.visibleText.includes("$"),
      `${zoom.label}: the blurred formula still displays literal dollar signs`,
    );
    assert(
      blurred.lineCount === 1,
      `${zoom.label}: the blurred formula uses ${blurred.lineCount} lines instead of one`,
    );
    assert(
      Math.abs(blurred.width - editing.width) <= 1,
      `${zoom.label}: formula width changed after blur: ${editing.width} -> ${blurred.width}`,
    );

    const records = await fetch(`${apiUrl}/api/board`).then((response) => response.json());
    assert(
      records.find((item) => item.id === shapeId)?.props?.autoSize === true,
      `${zoom.label}: the new formula text does not use autoSize=true`,
    );

    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".tl-canvas");
    await page.waitForTimeout(800);
    assert(
      (await page.getByRole("button", { name: /^Zoom/ }).getAttribute("aria-label")) ===
        `Zoom — ${zoom.label}`,
      `${zoom.label}: camera memory did not restore the zoom after reload`,
    );
    const reloaded = await inspectFormula(
      page.locator(`[data-shape-id="${shapeId}"] span[data-type="inline-math"]`),
    );
    assert(
      reloaded.lineCount === 1,
      `${zoom.label}: the reloaded formula uses ${reloaded.lineCount} lines instead of one`,
    );
    assert(
      Math.abs(reloaded.width - blurred.width) <= 1,
      `${zoom.label}: formula width changed after reload: ${blurred.width} -> ${reloaded.width}`,
    );
    assert(
      Math.abs(reloaded.shapeWidth - blurred.shapeWidth) <= 1,
      `${zoom.label}: shape width changed after reload: ${blurred.shapeWidth} -> ${reloaded.shapeWidth}`,
    );

    const zoomScreenshot = screenshot.replace(/(\.[^.]+)$/, `-${zoom.label.replace("%", "")}$1`);
    await page.screenshot({ path: zoomScreenshot });
    results.push({
      zoom: zoom.label,
      shapeId,
      editing,
      blurred,
      reloaded,
      screenshot: zoomScreenshot,
    });
    await page.close();
  }
  console.log(
    JSON.stringify(
      { ok: true, startup: "first double-click opened editor without errors", results },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
