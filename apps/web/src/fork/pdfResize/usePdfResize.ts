import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffectEvent, useLayoutEffect, useState, type RefObject } from "react";
import { currentPdfPage, pdfPageWidth } from "~/components/files/pdfLayout";
import { observeResize } from "~/lib/observeResize";

// pdfLayout's gap between pages and above the first one.
const GAP = 16;

type PdfPlace = { page: number; offset: number; width: number };

/**
 * Returns the current `page` from `currentPdfPage`, the pixel `offset` from the page top to
 * `scrollTop`, and `width`. That `offset` is negative in the gap above the page.
 */
export function pdfPlaceAt(
  offsets: readonly number[],
  pageCount: number,
  scrollTop: number,
  width: number,
): PdfPlace {
  const page = currentPdfPage(offsets, pageCount, scrollTop);
  return { page, offset: scrollTop - offsets[page]!, width };
}

/**
 * Returns the whole-pixel scroll top for `place` at `width`. Offsets inside a page scale with
 * `width`, and gap offsets above a page keep their pixel distance. The result stays within the
 * scroll range of the page column, so the top of the last page is always reachable.
 */
export function pdfPlaceTop(
  place: PdfPlace,
  offsets: readonly number[],
  width: number,
  viewportHeight: number,
) {
  const end = Math.max(offsets.at(-1)! - viewportHeight, offsets.at(-2)! - GAP, 0);
  return Math.min(placeSpot(place, offsets, width), Math.floor(end));
}

// Whole pixels, as the browser stores a scroll top, so the page number matches the saved view.
function placeSpot(place: PdfPlace, offsets: readonly number[], width: number) {
  // A spot inside the page stays inside it when the page measures shorter than first laid out.
  const height = offsets[place.page + 1]! - offsets[place.page]! - GAP;
  const inset =
    place.offset < 0
      ? place.offset
      : Math.min((place.offset * width) / place.width, Math.max(0, height - 1));
  return Math.round(Math.max(0, offsets[place.page]! + inset));
}

/**
 * In Fit width, holds `paintWidth` while `scroll` changes width and keeps the reading place in
 * `top`. Call `drop()` on page jumps, page buttons, and zoom. Call `onScroll` from the scroll
 * handler, `readTop` when saving the view, and `restore` after restoring a saved view.
 */
export function usePdfResize(
  scroll: RefObject<HTMLDivElement | null>,
  view: {
    pdf: PDFDocumentProxy | null;
    zoom: number | null;
    pageWidth: number;
    ratios: readonly number[];
    viewport: { width: number; height: number };
    width: number;
    offsets: readonly number[];
    scrollTop: number;
  },
) {
  const { pdf, zoom, pageWidth, ratios, viewport, width, offsets, scrollTop } = view;
  // The scroller width this document's pages were painted at when a Fit-width width change started.
  const [held, setHeld] = useState<{ pdf: PDFDocumentProxy; width: number } | null>(null);
  // A zoom change paints at the new width at once.
  const [heldZoom, setHeldZoom] = useState(zoom);
  if (heldZoom !== zoom) {
    setHeldZoom(zoom);
    setHeld(null);
  }
  const [place, setPlace] = useState<(PdfPlace & { pdf: PDFDocumentProxy }) | null>(null);
  const kept = pdf !== null && place?.pdf === pdf ? place : null;
  const top = kept ? pdfPlaceTop(kept, offsets, width, viewport.height) : scrollTop;
  const holding = pdf !== null && held?.pdf === pdf ? held : null;
  const paintWidth = holding ? pdfPageWidth(holding.width, pageWidth, zoom).width : width;
  // Only a Fit-width page changes width with the scroller.
  const resized = useEffectEvent((node: HTMLElement) => {
    // A document still loading has no paint to keep.
    if (node.clientWidth === viewport.width || zoom !== null || pdf === null) return false;
    setHeld((old) => (old?.pdf === pdf ? old : { pdf, width: viewport.width }));
    // Taken only when no place is kept, which a drop earlier in this frame may have just ended.
    setPlace((old) => {
      if (old?.pdf === pdf) return old;
      // The DOM holds the reader's scroll top, which a scroll event may not have rendered yet,
      // unless the view just grew taller at the end of the document and the browser clamped it.
      const clamped =
        node.scrollTop < top && node.scrollTop >= node.scrollHeight - node.clientHeight - 1;
      const from = clamped ? top : node.scrollTop;
      return { pdf, ...pdfPlaceAt(offsets, ratios.length, from, width) };
    });
    return true;
  });
  const settled = useEffectEvent((node: HTMLElement) => {
    // Otherwise a width the observer has not delivered yet restarts the wait.
    if (node.clientWidth === viewport.width) setHeld(null);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to the scroller through observeResize so the upstream viewport effect stays unchanged, observeResize flushes both updates in one render, and the settle timer and animation frames cancel on unmount.
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    const stop = observeResize(node, () => {
      if (!resized(node)) return;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      // A slow frame can outlast the timer; the next frame brings the drag's next width first.
      timer = setTimeout(() => {
        frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => settled(node))));
      }, 150);
    });
    return () => {
      stop();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [scroll]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Put the scroller on the kept place after each layout commit, before paint.
  useLayoutEffect(() => {
    if (kept) scroll.current?.scrollTo({ top });
  }, [scroll, kept, top]);
  return {
    top,
    paintWidth,
    /**
     * Returns true while the width changes and page `index` is outside the view, gap excluded.
     * Wait to start loading that page while true. A load that has started keeps running.
     */
    defer: (index: number) =>
      holding !== null &&
      (offsets[index]! >= top + viewport.height || offsets[index + 1]! - GAP <= top),
    drop: () => setPlace(null),
    onScroll: (node: HTMLElement) => {
      if (!kept || Math.abs(node.scrollTop - top) >= 1) setPlace(null);
    },
    /**
     * Returns the whole-pixel kept spot to save while `node` sits at the kept place, even when
     * the document end stops the view above it. Returns `node.scrollTop` otherwise.
     */
    readTop: (node: HTMLElement) =>
      kept && Math.abs(node.scrollTop - top) < 1 ? placeSpot(kept, offsets, width) : node.scrollTop,
    /**
     * Call after scrolling to a saved view on load. In Fit width, if `node` stops above `target`,
     * `restore` sets the kept place to `target` so saves keep it and widening returns to it.
     */
    restore: (node: HTMLElement, target: number) => {
      if (pdf !== null && zoom === null && target - node.scrollTop >= 1)
        setPlace({ pdf, ...pdfPlaceAt(offsets, ratios.length, target, width) });
    },
  };
}
