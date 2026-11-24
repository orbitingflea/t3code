import { useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { observeResize } from "~/lib/observeResize";
import { visiblePdfPages } from "~/components/files/pdfLayout";

const SETTLE_MS = 150;
/** `useResizeDrag` sets this body cursor for the length of a panel resize drag. */
const DRAG_CURSOR = "col-resize";

/**
 * Active resize drag for `pdf`, used only while that document stays loaded. `paintWidth` is the
 * page width when the drag began, and `mounted` holds the page indexes mounted at the last render.
 */
type Drag = { pdf: PDFDocumentProxy; paintWidth: number; mounted: ReadonlySet<number> };

/**
 * Defers Fit width (`zoom === null`) repaints and leaves scroll to the viewer. A hold starts only
 * on a panel-drag width change with a loaded PDF. It ends 150 ms after the last width change, or at
 * once on a zoom change, new PDF, or non-drag width change. Non-drag, height-only, and fixed-zoom
 * resizes pass through. While held, mounted pages skip pdf.js work, stretch, then repaint once.
 */
export function usePdfResize({
  scroll,
  pdf,
  zoom,
  width,
  viewport,
  ratios,
  offsets,
  scrollTop,
}: {
  scroll: RefObject<HTMLDivElement | null>;
  pdf: PDFDocumentProxy | null;
  zoom: number | null;
  width: number;
  viewport: { width: number; height: number };
  ratios: readonly number[];
  offsets: readonly number[];
  scrollTop: number;
}) {
  const [state, setDrag] = useState<Drag | null>(null);
  // A zoom change or a new document ends the drag at once.
  const drag = state?.pdf === pdf && zoom === null ? state : null;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const near = visiblePdfPages(ratios, offsets, scrollTop, viewport.height);
  const visible = drag
    ? near.filter(
        ({ index, ratio }) =>
          drag.mounted.has(index) ||
          (offsets[index]! < scrollTop + viewport.height &&
            offsets[index]! + width * ratio > scrollTop),
      )
    : near;
  // A page stays mounted for the rest of the drag while it remains in the preload range.
  if (state && !drag) setDrag(null);
  else if (
    drag &&
    (visible.length !== drag.mounted.size || visible.some(({ index }) => !drag.mounted.has(index)))
  )
    setDrag({ ...drag, mounted: new Set(visible.map(({ index }) => index)) });

  const resized = useEffectEvent((node: HTMLDivElement) => {
    if (!pdf || zoom !== null || node.clientWidth === viewport.width) return false;
    // A width change outside a panel drag, such as a maximize, ends the hold at once.
    if (document.body.style.cursor !== DRAG_CURSOR) {
      setDrag(null);
      return false;
    }
    const mounted = new Set(visible.map(({ index }) => index));
    setDrag((last) => (last?.pdf === pdf ? last : { pdf, paintWidth: width, mounted }));
    return true;
  });
  const settled = useEffectEvent((node: HTMLDivElement) => {
    if (node.clientWidth !== viewport.width) return false;
    setDrag(null);
    return true;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observes `scroll` size to start the drag before the resized width commits and run the settle timer.
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const wait = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => settled(node) || wait(), SETTLE_MS);
    };
    const stop = observeResize(node, () => resized(node) && wait());
    return () => {
      stop();
      clearTimeout(timer.current);
    };
  }, [scroll]);

  return {
    /**
     * Pages to mount. Outside a drag, `visible` matches the viewer's preload list. During a
     * drag, mounted pages stay mounted while in the preload range, and on-screen pages mount.
     * A page that leaves that range unmounts, and it mounts again if the reader scrolls it
     * back on screen. Off-screen pages that enter that range wait until the drag ends.
     */
    visible,
    /**
     * Width to paint pages at. Holds the starting width during a drag so pages skip pdf.js work,
     * and passes through the live `width` after the drag so each mounted page repaints once.
     */
    paintWidth: drag ? drag.paintWidth : width,
  };
}
