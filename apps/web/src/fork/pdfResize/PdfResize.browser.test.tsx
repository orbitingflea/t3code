import { expect, it, vi } from "vite-plus/test";
import { fakeTimers, render } from "../../../test/render";
import "~/index.css";

vi.mock(import("pdfjs-dist/build/pdf.worker.min.mjs?url"), async () => {
  const { default: source } = await import("pdfjs-dist/build/pdf.worker.min.mjs?raw");
  return {
    default: URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
  };
});

// Counts pdf.js paints per page; `waiters` let a test wait for a paint without timers.
const paints = vi.hoisted(() => ({
  count: 0,
  pages: [] as number[],
  waiters: new Set<() => void>(),
}));
vi.mock(import("~/components/files/pdfDocument"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openPdf: (bytes) => {
      const task = actual.openPdf(bytes);
      const counted = new WeakSet<object>();
      const promise = task.promise.then((document) => {
        const getPage = document.getPage.bind(document);
        document.getPage = async (number) => {
          const page = await getPage(number);
          // pdf.js returns the same page proxy on every call, so wrap it once.
          if (counted.has(page)) return page;
          counted.add(page);
          const paint = page.render.bind(page);
          page.render = (params) => {
            paints.count++;
            paints.pages.push(number);
            for (const waiter of paints.waiters) waiter();
            return paint(params);
          };
          return page;
        };
        return document;
      });
      return Object.defineProperty(task, "promise", { value: promise });
    },
  };
});

import PdfViewer from "~/components/files/PdfViewer";

function letterPages(count: number) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] >>`,
    ...Array.from({ length: count }, (_, i) => {
      const text = `BT /F1 24 Tf 30 700 Td (Page ${i + 1}) Tj ET`;
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + count * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
        `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
      ];
    }).flat(),
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
  return new Blob([source], { type: "application/pdf" });
}

/** The page at the top of the view and how far into it the view starts, as a share of its height. */
function readingSpot(region: HTMLElement) {
  const top = region.getBoundingClientRect().top;
  for (const canvas of region.querySelectorAll("canvas")) {
    const box = canvas.getBoundingClientRect();
    if (box.bottom > top + 1)
      return { page: canvas.getAttribute("aria-label"), into: (top - box.top) / box.height };
  }
  return null;
}

/** Every mounted page is painted at its current size. */
function sharp(region: HTMLElement) {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  return Array.from(region.querySelectorAll("canvas")).every(
    (canvas) => canvas.width === Math.ceil(canvas.getBoundingClientRect().width * ratio),
  );
}

function container() {
  const element = document.createElement("div");
  element.style.cssText = "display:flex;width:600px;height:600px";
  return element;
}

async function atPage5(screen: Awaited<ReturnType<typeof render>>, title: string) {
  await expect.element(screen.getByText("1 / 12 pages"), { timeout: 10_000 }).toBeVisible();
  const region = screen.getByRole("region", { name: title }).element() as HTMLElement;
  const pageWidth = region.clientWidth - 32;
  region.scrollTop = 4 * ((pageWidth * 792) / 612 + 16) + 120;
  await expect.element(screen.getByText("5 / 12 pages")).toBeVisible();
  await vi.waitFor(() => expect(sharp(region)).toBe(true));
  return region;
}

/** Sets each panel width in turn and waits until the viewer has measured it. */
async function drag(panel: HTMLElement, widths: number[], each?: () => void) {
  const region = panel.querySelector('[role="region"]')!;
  for (const width of widths) {
    const measured = new Promise((resolve) => {
      const observer = new ResizeObserver(() => resolve(observer.disconnect()));
      observer.observe(region);
    });
    panel.style.width = `${width}px`;
    await measured;
    each?.();
  }
}

const steps = (from: number, to: number) =>
  Array.from(
    { length: Math.abs(to - from) / 8 },
    (_, i) => from + Math.sign(to - from) * 8 * (i + 1),
  );

/**
 * Sets the body cursor as `useResizeDrag` does for a panel resize drag, and holds the viewer's
 * timers with fake timers so a slow test frame cannot end the drag. `release` runs pending
 * timers, clears the body cursor, and restores real timers.
 */
function pointerDrag() {
  document.body.style.cursor = "col-resize";
  const timers = fakeTimers();
  const end = () => {
    document.body.style.removeProperty("cursor");
    timers[Symbol.dispose]();
  };
  return {
    release: () => {
      vi.runOnlyPendingTimers();
      end();
    },
    [Symbol.dispose]: end,
  };
}

async function open(url: string, title: string) {
  const panel = container();
  const screen = await render(<PdfViewer src={url} title={title} />, { container: panel });
  try {
    const region = await atPage5(screen, title);
    return { panel, screen, region, [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose]() };
  } catch (cause) {
    await screen[Symbol.asyncDispose]();
    throw cause;
  }
}

/** The page numbers of the canvases that intersect the scroll view. */
function onScreen(region: HTMLElement) {
  const view = region.getBoundingClientRect();
  return Array.from(region.querySelectorAll("canvas")).flatMap((canvas) => {
    const box = canvas.getBoundingClientRect();
    return box.bottom > view.top && box.top < view.bottom
      ? [Number(canvas.getAttribute("aria-label")!.replace("Page ", ""))]
      : [];
  });
}

/** Resolves once pdf.js has started a paint of each page; `vi.waitFor` would end a held drag. */
function painted(pages: number[]) {
  return new Promise<void>((resolve) => {
    const check = () => {
      if (!pages.every((page) => paints.pages.includes(page))) return;
      paints.waiters.delete(check);
      resolve();
    };
    paints.waiters.add(check);
    check();
  });
}

it("keeps the reader's page and paints nothing while the width is dragged, then repaints sharp", async () => {
  const url = URL.createObjectURL(letterPages(12));
  try {
    await using viewer = await open(url, "Dragged PDF");
    const { panel, region, screen } = viewer;
    const before = readingSpot(region)!;
    paints.count = 0;
    const pages: string[] = [];
    using timers = pointerDrag();
    await drag(panel, [...steps(600, 360), ...steps(360, 480)], () =>
      pages.push(readingSpot(region)!.page!),
    );
    expect(new Set(pages)).toEqual(new Set([before.page]));
    expect(screen.container.textContent).toContain("5 / 12 pages");
    expect(paints.count).toBe(0);

    timers.release();
    await vi.waitFor(() => expect(sharp(region)).toBe(true));
    const after = readingSpot(region)!;
    expect(after.page).toBe(before.page);
    expect(after.into).toBeCloseTo(before.into, 2);
    expect(paints.count).toBeGreaterThan(0);
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("paints no page that leaves and re-enters the preloaded range in one drag", async () => {
  const url = URL.createObjectURL(letterPages(12));
  try {
    await using viewer = await open(url, "Widened PDF");
    paints.count = 0;
    using timers = pointerDrag();
    await drag(viewer.panel, [...steps(600, 1000), ...steps(1000, 520)]);
    expect(paints.count).toBe(0);
    timers.release();
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("keeps the page number when the width grows from the top of a page", async () => {
  const url = URL.createObjectURL(letterPages(12));
  try {
    await using viewer = await open(url, "Page start PDF");
    const { panel, screen } = viewer;
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.element(screen.getByText("6 / 12 pages")).toBeVisible();
    using timers = pointerDrag();
    const labels: string[] = [];
    await drag(panel, steps(600, 760), () =>
      labels.push(screen.container.textContent!.match(/\d+ \/ 12 pages/)![0]),
    );
    expect(new Set(labels)).toEqual(new Set(["6 / 12 pages"]));
    timers.release();
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("holds the spot the reader scrolls to in the middle of a drag", async () => {
  const url = URL.createObjectURL(letterPages(12));
  try {
    await using viewer = await open(url, "Scrolled PDF");
    const { panel, region, screen } = viewer;
    using timers = pointerDrag();
    await drag(panel, steps(600, 520));
    const scrolled = new Promise((resolve) =>
      region.addEventListener("scroll", resolve, { once: true }),
    );
    region.scrollTop += 2 * region.querySelector("canvas")!.getBoundingClientRect().height;
    await scrolled;
    const moved = readingSpot(region)!;
    expect(moved.page).toBe("Page 7");

    await drag(panel, steps(520, 400));
    expect(readingSpot(region)!.page).toBe("Page 7");
    expect(readingSpot(region)!.into).toBeCloseTo(moved.into, 2);
    await expect.element(screen.getByText("7 / 12 pages")).toBeVisible();
    timers.release();
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("paints each page that a scroll brings on screen in the middle of a drag only once", async () => {
  const url = URL.createObjectURL(letterPages(12));
  try {
    await using viewer = await open(url, "Far PDF");
    const { panel, region } = viewer;
    using timers = pointerDrag();
    await drag(panel, steps(600, 560));
    const scrolled = new Promise((resolve) =>
      region.addEventListener("scroll", resolve, { once: true }),
    );
    paints.pages = [];
    region.scrollTop = region.scrollHeight;
    await scrolled;
    await drag(panel, [552]);
    const shown = onScreen(region);
    expect(shown.length).toBeGreaterThan(0);
    await painted(shown);
    await drag(panel, steps(552, 400));
    expect(paints.pages.toSorted()).toEqual(shown.toSorted());
    timers.release();
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("passes the zoomed preload range through when the zoom changes in the middle of a drag", async () => {
  const url = URL.createObjectURL(letterPages(12));
  try {
    await using viewer = await open(url, "Zoomed PDF");
    const { panel, region, screen } = viewer;
    using timers = pointerDrag();
    await drag(panel, steps(600, 560));
    const mounted = region.querySelectorAll("canvas").length;
    await screen.getByRole("button", { name: "Zoom out", exact: true }).click();
    expect(region.querySelectorAll("canvas").length).toBeGreaterThan(mounted);
    timers.release();
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("mounts the taller preload range at once when only the height changes", async () => {
  const url = URL.createObjectURL(letterPages(12));
  try {
    await using viewer = await open(url, "Taller PDF");
    const { panel, region } = viewer;
    using timers = pointerDrag();
    const mounted = region.querySelectorAll("canvas").length;
    const measured = new Promise((resolve) => {
      const observer = new ResizeObserver(() => resolve(observer.disconnect()));
      observer.observe(region);
    });
    panel.style.height = "1000px";
    await measured;
    expect(region.querySelectorAll("canvas").length).toBeGreaterThan(mounted);
    timers.release();
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("paints a page that crosses the screen edge in the middle of a drag only once", async () => {
  const url = URL.createObjectURL(letterPages(12));
  try {
    await using viewer = await open(url, "Edge PDF");
    const { panel, region } = viewer;
    using timers = pointerDrag();
    await drag(panel, steps(600, 560));
    const label = () => panel.textContent!.match(/\d+ \/ 12 pages/)![0];
    // Waits for the page label to change, which shows the viewer rendered the new place.
    // `vi.waitFor` would advance the held timers and end the drag.
    const scrollTo = async (top: number) => {
      const before = label();
      const rendered = new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (label() !== before) resolve(observer.disconnect());
        });
        observer.observe(panel, { subtree: true, childList: true, characterData: true });
      });
      region.scrollTop = top;
      await rendered;
    };
    paints.pages = [];
    const end = region.scrollHeight - region.clientHeight;
    await scrollTo(end);
    await scrollTo(end - 1.5 * region.clientHeight);
    await scrollTo(end);
    await drag(panel, steps(560, 520));
    expect(paints.pages.length).toBeGreaterThan(0);
    expect(paints.pages.length).toBe(new Set(paints.pages).size);
    timers.release();
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("holds the painted width until 150 ms after the last width change of a slow drag", async () => {
  const url = URL.createObjectURL(letterPages(12));
  try {
    await using viewer = await open(url, "Slow PDF");
    const { panel, region } = viewer;
    paints.count = 0;
    using timers = pointerDrag();
    const widths = steps(600, 440);
    await drag(panel, widths.slice(0, -1), () => vi.advanceTimersByTime(100));
    await drag(panel, widths.slice(-1));
    expect(paints.count).toBe(0);
    const mounted = region.querySelectorAll("canvas").length;
    // Small steps let React commit the update that each fired timer schedules before the check.
    const tick = async (ms: number) => {
      for (let done = 0; done < ms; done += 10) await vi.advanceTimersByTimeAsync(10);
    };
    await tick(140);
    expect(region.querySelectorAll("canvas").length).toBe(mounted);
    await tick(20);
    expect(region.querySelectorAll("canvas").length).toBeGreaterThan(mounted);
    timers.release();
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("mounts and repaints as before when the width changes outside a panel drag", async () => {
  const url = URL.createObjectURL(letterPages(12));
  try {
    await using viewer = await open(url, "Maximized PDF");
    const { panel, region } = viewer;
    const shown = onScreen(region);
    const mounted = region.querySelectorAll("canvas").length;
    using _timers = fakeTimers();
    paints.pages = [];
    await drag(panel, [360]);
    expect(region.querySelectorAll("canvas").length).toBeGreaterThan(mounted);
    await vi.advanceTimersByTimeAsync(160);
    expect(shown.filter((page) => !paints.pages.includes(page))).toEqual([]);
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("passes the next width change straight through once the panel drag is released", async () => {
  const url = URL.createObjectURL(letterPages(12));
  try {
    await using viewer = await open(url, "Released PDF");
    const { panel, region } = viewer;
    using timers = pointerDrag();
    await drag(panel, steps(600, 560));
    // The pointer goes up and the panel is maximized before the drag's settle timer fires.
    document.body.style.removeProperty("cursor");
    const shown = onScreen(region);
    paints.pages = [];
    await drag(panel, [360]);
    await vi.advanceTimersByTimeAsync(160);
    expect(shown.filter((page) => !paints.pages.includes(page))).toEqual([]);
    timers.release();
  } finally {
    URL.revokeObjectURL(url);
  }
});
