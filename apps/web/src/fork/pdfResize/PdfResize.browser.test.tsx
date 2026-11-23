import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import "~/index.css";

// Vite serves the worker through its transform with a large inline source map; a blob of the raw
// file is the same code without that cost.
vi.mock(import("pdfjs-dist/build/pdf.worker.min.mjs?url"), async () => {
  const { default: source } = await import("pdfjs-dist/build/pdf.worker.min.mjs?raw");
  return {
    default: URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
  };
});

// pdf.js work per page number (paints, text-layer builds, cache cleanups), one page whose
// getPage waits until the test opens it, and a switch that makes repaint setup throw.
const pdfWork = vi.hoisted(() => ({
  pages: new Map<number, { paints: number; texts: number; cleanups: number }>(),
  held: 0,
  failRepaint: false,
  open: () => {},
  opened: Promise.resolve(),
}));
function setup(held = 0) {
  pdfWork.pages.clear();
  pdfWork.held = held;
  pdfWork.failRepaint = false;
  pdfWork.opened = new Promise((resolve) => (pdfWork.open = resolve));
}
function work(number: number) {
  return { ...(pdfWork.pages.get(number) ?? { paints: 0, texts: 0, cleanups: 0 }) };
}
vi.mock(import("~/components/files/pdfDocument"), async (importOriginal) => {
  const actual = await importOriginal();
  const counted = new WeakSet<object>();
  return {
    ...actual,
    openPdf: (bytes) => {
      const task = actual.openPdf(bytes);
      const promise = task.promise.then((document) => {
        const getPage = document.getPage.bind(document);
        document.getPage = async (number) => {
          const page = await getPage(number);
          if (number === pdfWork.held) await pdfWork.opened;
          if (counted.has(page)) return page;
          counted.add(page);
          const count = (key: "paints" | "texts" | "cleanups") => {
            const row = work(number);
            pdfWork.pages.set(number, { ...row, [key]: row[key] + 1 });
          };
          const getViewport = page.getViewport.bind(page);
          page.getViewport = (params) => {
            if (pdfWork.failRepaint && params?.scale !== 1) throw new Error("Viewport failed");
            return getViewport(params);
          };
          const render = page.render.bind(page);
          page.render = (params) => (count("paints"), render(params));
          const streamTextContent = page.streamTextContent.bind(page);
          page.streamTextContent = (params) => (count("texts"), streamTextContent(params));
          const cleanup = page.cleanup.bind(page);
          page.cleanup = (resetStats) => (count("cleanups"), cleanup(resetStats));
          return page;
        };
        return document;
      });
      return Object.defineProperty(task, "promise", { value: promise });
    },
  };
});

import PdfViewer from "~/components/files/PdfViewer";

// Resolves when the observers run after the next layout, the same step the viewer measures in.
function nextResize(element: Element) {
  return new Promise<void>((resolve) =>
    new ResizeObserver((_entries, observer) => {
      observer.disconnect();
      resolve();
    }).observe(element),
  );
}
async function resizeTo(container: HTMLElement, width: number) {
  const resized = nextResize(container);
  container.style.width = `${width}px`;
  await resized;
}

type TestPage = { box: string; rotate?: number; text: string };
const letter = (text: string, box = "0 0 612 792"): TestPage => ({
  box,
  text: `BT /F1 24 Tf 30 340 Td (${text}) Tj ET`,
});

function testPdf(pages: TestPage[]) {
  const fonts = 3 + pages.length * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] >>`,
    ...pages.flatMap(({ box, rotate = 0, text }, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Rotate ${rotate} /Resources << /Font << /F1 ${fonts} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    ]),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return URL.createObjectURL(new Blob([source], { type: "application/pdf" }));
}

async function mountViewer(url: string, title: string, width: number, height: number) {
  const container = document.createElement("div");
  container.style.cssText = `display:flex;width:${width}px;height:${height}px`;
  const screen = await render(<PdfViewer src={url} title={title} />, { container });
  const region = screen.getByRole("region", { name: title }).element() as HTMLElement;
  return { screen, container, region };
}

it("keeps the painted page and its text through a width drag, then repaints once without a blank frame", async () => {
  setup();
  const url = testPdf([
    { box: "0 0 612 140", text: "BT /F1 24 Tf 30 70 Td (Quarterly outlook) Tj ET" },
    letter("Budget"),
  ]);
  try {
    const { screen, container, region } = await mountViewer(url, "Resized PDF", 500, 600);
    await using _screen = screen;
    await expect.element(screen.getByText("1 / 2 pages"), { timeout: 10_000 }).toBeVisible();
    const canvas = region.querySelector<HTMLCanvasElement>('canvas[aria-label="Page 1"]')!;
    const bitmapWidth = () =>
      Math.ceil((region.clientWidth - 32) * Math.min(2, window.devicePixelRatio));
    await vi.waitFor(() => expect(canvas.width).toBe(bitmapWidth()));
    const painted = canvas.width;
    const span = await vi.waitFor(() => {
      const node = region.querySelector("[data-pdf-text-layer] span");
      expect(node).not.toBeNull();
      return node!;
    });
    const before = work(1);

    // A canvas loses its pixels when its bitmap is resized, so read them as soon as that happens.
    const repainted = new Promise<number[]>((resolve) =>
      new MutationObserver(() =>
        resolve(Array.from(canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data)),
      ).observe(canvas, { attributeFilter: ["width"] }),
    );
    // A drag moves the width on every frame, so no frame in it is a pause.
    for (const width of [480, 450, 420, 400]) {
      await resizeTo(container, width);
      expect(canvas.getBoundingClientRect().width).toBe(region.clientWidth - 32);
      expect(span.getBoundingClientRect().right).toBeLessThan(canvas.getBoundingClientRect().right);
      expect(canvas.width).toBe(painted);
    }
    // A page jump ends the kept place, not the drag's paint hold.
    await act(() => {
      screen
        .getByRole("button", { name: "Next page", exact: true })
        .element()
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await resizeTo(container, 390);
    expect(canvas.width).toBe(painted);
    expect(work(1)).toEqual(before);

    expect(await repainted).toEqual([255, 255, 255, 255]);
    expect(canvas.width).toBe(bitmapWidth());
    expect(work(1)).toEqual({ ...before, paints: before.paints + 1 });
    expect(span.isConnected).toBe(true);
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("keeps the reader's page and spot while a fit-width panel changes width, until they scroll", async () => {
  setup();
  const url = testPdf(["One", "Two", "Three", "Four", "Five", "Six"].map((text) => letter(text)));
  try {
    const { screen, container, region } = await mountViewer(url, "Anchored PDF", 420, 300);
    await using _screen = screen;
    await expect.element(screen.getByText("1 / 6 pages"), { timeout: 10_000 }).toBeVisible();
    const pageBox = (number: number) =>
      region.querySelector(`canvas[aria-label="Page ${number}"]`)!.getBoundingClientRect();
    const spot = (number: number) =>
      (region.getBoundingClientRect().top - pageBox(number).top) / pageBox(number).height;
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.element(screen.getByText("3 / 6 pages")).toBeVisible();
    const scrolled = new Promise((resolve) =>
      region.addEventListener("scroll", resolve, { once: true }),
    );
    region.scrollTop += pageBox(3).height / 3;
    await scrolled;
    const kept = spot(3);

    for (const width of [400, 360, 300, 360, 460]) {
      await resizeTo(container, width);
      expect(screen.container.textContent).toContain("3 / 6 pages");
      expect(spot(3)).toBeCloseTo(kept, 2);
    }

    // The reader's own scroll ends the kept place; the next drag keeps the new spot.
    const moved = new Promise((resolve) =>
      region.addEventListener("scroll", resolve, { once: true }),
    );
    region.scrollTop += pageBox(3).height / 4;
    await moved;
    const next = spot(3);
    expect(next).toBeGreaterThan(kept + 0.2);
    for (const width of [400, 320]) {
      await resizeTo(container, width);
      expect(spot(3)).toBeCloseTo(next, 2);
    }

    // A page button leaves the view in the gap above the page; that gap does not grow with it.
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.element(screen.getByText("4 / 6 pages")).toBeVisible();
    const gap = pageBox(4).top - region.getBoundingClientRect().top;
    await resizeTo(container, 480);
    expect(screen.container.textContent).toContain("4 / 6 pages");
    expect(pageBox(4).top - region.getBoundingClientRect().top).toBeCloseTo(gap, 0);
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("keeps the reader's place when a narrower width shortens the document below it", async () => {
  setup();
  const url = testPdf([letter("First", "0 0 612 612"), letter("Last", "0 0 612 612")]);
  try {
    const { screen, container, region } = await mountViewer(url, "Short PDF", 620, 360);
    await using _screen = screen;
    await expect.element(screen.getByText("1 / 2 pages"), { timeout: 10_000 }).toBeVisible();
    const gap = () =>
      region.querySelector('canvas[aria-label="Page 2"]')!.getBoundingClientRect().top -
      region.getBoundingClientRect().top;
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    const scrolled = new Promise((resolve) =>
      region.addEventListener("scroll", resolve, { once: true }),
    );
    region.scrollTop += 116;
    await scrolled;

    // The kept spot is past the end of the shorter document, so the view stops at the end,
    // where the last page's top sits one gap below the top of the view.
    await resizeTo(container, 260);
    expect(Math.round(gap())).toBe(16);
    expect(screen.container.textContent).toContain("2 / 2 pages");
    // Widening back finds the kept spot again.
    await resizeTo(container, 620);
    expect(Math.round(gap())).toBe(-100);
    expect(screen.container.textContent).toContain("2 / 2 pages");
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("saves the kept spot, not the end the narrow view stops at", async () => {
  setup();
  const url = testPdf([letter("First", "0 0 612 612"), letter("Last", "0 0 612 612")]);
  const viewer = (mount: number) => (
    <PdfViewer key={mount} src={url} title="Saved PDF" positionKey="resize:saved" />
  );
  try {
    const container = document.createElement("div");
    container.style.cssText = "display:flex;width:620px;height:360px";
    await using screen = await render(viewer(1), { container });
    await expect.element(screen.getByText("1 / 2 pages"), { timeout: 10_000 }).toBeVisible();
    const region = () => screen.getByRole("region", { name: "Saved PDF" }).element();
    const gap = () =>
      region().querySelector('canvas[aria-label="Page 2"]')!.getBoundingClientRect().top -
      region().getBoundingClientRect().top;
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    const scrolled = new Promise((resolve) =>
      region().addEventListener("scroll", resolve, { once: true }),
    );
    region().scrollTop += 116;
    await scrolled;
    await resizeTo(container, 260);
    expect(Math.round(gap())).toBe(16);

    // Reopened wider, the view goes back inside page 2, not to its top.
    await screen.rerender(<div />);
    container.style.width = "620px";
    await screen.rerender(viewer(2));
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    await vi.waitFor(() => expect(gap()).toBeLessThan(-50));
    const spot = gap();

    // Reopened while still narrow, the view stops at the end again, and widening finds the spot.
    await resizeTo(container, 260);
    await screen.rerender(<div />);
    await screen.rerender(viewer(3));
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    await vi.waitFor(() => expect(Math.round(gap())).toBe(16));
    await resizeTo(container, 620);
    expect(gap()).toBeCloseTo(spot, 0);
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("keeps the reader's place when widening lets the toolbar fit on one row at the document end", async () => {
  setup();
  const url = testPdf([letter("First"), letter("Last")]);
  try {
    const { screen, container, region } = await mountViewer(url, "Toolbar PDF", 250, 340);
    await using _screen = screen;
    await vi.waitFor(() => expect(work(2).paints).toBe(1));
    const page = region.querySelector<HTMLCanvasElement>('canvas[aria-label="Page 2"]')!;
    const spot = () =>
      (region.getBoundingClientRect().top - page.getBoundingClientRect().top) /
      page.getBoundingClientRect().height;
    const scrolled = new Promise((resolve) =>
      region.addEventListener("scroll", resolve, { once: true }),
    );
    region.scrollTop = region.scrollHeight;
    await scrolled;
    await expect.element(screen.getByText("2 / 2 pages")).toBeVisible();
    const kept = spot();
    const height = region.clientHeight;

    await resizeTo(container, 540);
    // The toolbar now fits on one row, so the view is taller.
    expect(region.clientHeight).toBeGreaterThan(height);
    expect(spot()).toBeCloseTo(kept, 2);
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("keeps the kept place, page number and mounted pages in step when a page above is measured late", async () => {
  // Page 1 is a short banner, so every page is first laid out at its height until measured.
  setup(2);
  const url = testPdf([
    letter("Banner", "0 0 612 140"),
    ...["Two", "Three", "Four", "Five", "Six"].map((text) => letter(text)),
  ]);
  try {
    const { screen, container, region } = await mountViewer(url, "Measured PDF", 420, 900);
    await using _screen = screen;
    await expect.element(screen.getByText("1 / 6 pages"), { timeout: 10_000 }).toBeVisible();
    const pageBox = (number: number) =>
      region.querySelector(`canvas[aria-label="Page ${number}"]`)!.getBoundingClientRect();
    await vi.waitFor(() => expect(work(5).paints).toBe(1));
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.element(screen.getByText("4 / 6 pages")).toBeVisible();
    const scrolled = new Promise((resolve) =>
      region.addEventListener("scroll", resolve, { once: true }),
    );
    region.scrollTop += pageBox(4).height / 3;
    await scrolled;
    const spot = () => region.getBoundingClientRect().top - pageBox(4).top;
    const kept = spot() / pageBox(4).height;

    await resizeTo(container, 380);
    expect(spot() / pageBox(4).height).toBeCloseTo(kept, 2);
    // Page 2 is measured now, well above the reader, and its real height pushes page 4 down.
    const top = region.scrollTop;
    pdfWork.open();
    await vi.waitFor(() => expect(region.scrollTop).toBeGreaterThan(top + 100));
    expect(spot() / pageBox(4).height).toBeCloseTo(kept, 2);
    expect(screen.container.textContent).toContain("4 / 6 pages");
    // The viewer navigates from where the view is, not from where it was before the measurement.
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.element(screen.getByText("5 / 6 pages")).toBeVisible();
    await vi.waitFor(() =>
      expect(pageBox(5).top - region.getBoundingClientRect().top).toBeCloseTo(16, 0),
    );
  } finally {
    pdfWork.open();
    URL.revokeObjectURL(url);
  }
});

it("loads a page that mounts off screen during a drag only once the width settles", async () => {
  setup();
  const url = testPdf(
    ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"].map((text) => letter(text)),
  );
  try {
    const { screen, container, region } = await mountViewer(url, "Narrowed PDF", 600, 600);
    await using _screen = screen;
    await expect.element(screen.getByText("1 / 8 pages"), { timeout: 10_000 }).toBeVisible();
    const mounted = () =>
      Array.from(region.querySelectorAll("canvas"), (canvas) =>
        Number(canvas.getAttribute("aria-label")!.replace("Page ", "")),
      );
    await vi.waitFor(() => expect(work(1).paints).toBe(1));
    const before = new Set(mounted());

    // Narrower pages are shorter, so more of them fall inside the mounted window.
    for (const width of [520, 440, 360, 280]) await resizeTo(container, width);
    const joined = mounted().filter((number) => !before.has(number));
    expect(joined.length).toBeGreaterThan(0);
    for (const number of joined) expect(work(number).texts).toBe(0);
    // Back at the starting width the drag is still moving, so none of them loads yet.
    await resizeTo(container, 600);
    for (const number of joined) expect(work(number).texts).toBe(0);
    await resizeTo(container, 280);

    await vi.waitFor(() => {
      for (const number of joined) expect(work(number).texts).toBe(1);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("paints a page that comes into view while the width is still changing", async () => {
  setup();
  const url = testPdf([letter("First", "0 0 612 382.5"), letter("Second", "0 0 612 382.5")]);
  try {
    const { screen, container, region } = await mountViewer(url, "Growing PDF", 1600, 340);
    await using _screen = screen;
    await vi.waitFor(() => expect(work(1).paints).toBe(1));
    const second = () => region.querySelector<HTMLCanvasElement>('canvas[aria-label="Page 2"]');
    expect(second()).toBeNull();

    // Page 2 mounts below the view and waits; narrower still, its top comes into view.
    await resizeTo(container, 540);
    expect(second()!.getBoundingClientRect().top).toBeGreaterThan(
      region.getBoundingClientRect().bottom,
    );
    expect(work(2).texts).toBe(0);
    await resizeTo(container, 450);
    expect(second()!.getBoundingClientRect().top).toBeLessThan(
      region.getBoundingClientRect().bottom,
    );
    // A drag that keeps moving never settles, so a paint here did not wait for the settle.
    for (let step = 0; step < 200 && work(2).paints === 0; step++)
      await resizeTo(container, step % 2 ? 450 : 449);
    expect(work(2).paints).toBe(1);
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("paints once at the fit width when Fit width is chosen while a zoomed panel changes width", async () => {
  setup();
  const url = testPdf([letter("One")]);
  try {
    const { screen, container, region } = await mountViewer(url, "Refit PDF", 600, 600);
    await using _screen = screen;
    await vi.waitFor(() => expect(work(1).paints).toBe(1));
    await screen.getByRole("button", { name: "Zoom in", exact: true }).click();
    await vi.waitFor(() => expect(work(1).paints).toBe(2));
    for (const width of [580, 560, 540]) await resizeTo(container, width);
    await screen.getByRole("button", { name: "Fit width", exact: true }).click();
    const canvas = region.querySelector<HTMLCanvasElement>("canvas")!;
    await vi.waitFor(() =>
      expect(canvas.width).toBe(
        Math.ceil((region.clientWidth - 32) * Math.min(2, window.devicePixelRatio)),
      ),
    );
    // One paint reached the fit width, with none at the width the zoomed drag started at.
    expect(work(1).paints).toBe(3);
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("paints a PDF that opens while the width changes once, at the current width", async () => {
  setup(1);
  const url = testPdf([letter("One")]);
  try {
    const { screen, container, region } = await mountViewer(url, "Opening PDF", 650, 600);
    await using _screen = screen;
    for (const width of [560, 480, 400, 315]) await resizeTo(container, width);
    pdfWork.open();
    await vi.waitFor(() => expect(work(1).paints).toBe(1));
    const canvas = region.querySelector<HTMLCanvasElement>("canvas")!;
    await vi.waitFor(() =>
      expect(canvas.width).toBe(
        Math.ceil((region.clientWidth - 32) * Math.min(2, window.devicePixelRatio)),
      ),
    );
    expect(work(1).paints).toBe(1);
  } finally {
    pdfWork.open();
    URL.revokeObjectURL(url);
  }
});

it("offers Try again when a repaint cannot start", async () => {
  setup();
  const url = testPdf([letter("One")]);
  try {
    const { screen, container } = await mountViewer(url, "Retried PDF", 500, 600);
    await using _screen = screen;
    await vi.waitFor(() => expect(work(1).paints).toBe(1));
    pdfWork.failRepaint = true;
    await resizeTo(container, 540);
    await expect.element(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    pdfWork.failRepaint = false;
    await screen.getByRole("button", { name: "Try again" }).click();
    // The reloaded document paints the page again.
    await vi.waitFor(() => expect(work(1).paints).toBe(2));
    await expect.element(screen.getByText("1 / 1 page")).toBeVisible();
  } finally {
    URL.revokeObjectURL(url);
  }
});
