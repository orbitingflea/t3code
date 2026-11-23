import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { msg } from "gt-react";
import { TextLayer, type PageViewport, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { pdfLinkPage, type PdfLink } from "~/components/files/PdfViewer";
import { m } from "~/i18n/messages";
import "./pdfResize.css";

/**
 * Loads a pdf.js page, its text layer, and links once per mount, and releases page resources on
 * unmount. Waits while `defer` is true at mount. Reports size to `onSize` and errors to `onError`.
 * Paints `canvas` off screen at `paintWidth`, swaps it whole, and repaints only when `paintWidth`
 * changes. Returns `links` and `textStyle` for a wrapper that scales the text layer to `width`.
 */
export function usePdfPagePaint(
  canvas: RefObject<HTMLCanvasElement | null>,
  text: RefObject<HTMLDivElement | null>,
  props: {
    document: PDFDocumentProxy;
    index: number;
    width: number;
    paintWidth: number;
    defer: boolean;
    onSize: (index: number, ratio: number) => void;
    onError: (error: string) => void;
  },
) {
  const [loaded, setLoaded] = useState<{
    pdf: PDFDocumentProxy;
    page: PDFPageProxy;
    layer: TextLayer;
    natural: PageViewport;
  } | null>(null);
  const [links, setLinks] = useState<readonly PdfLink[]>([]);
  // The page and width the canvas holds a paint of.
  const painted = useRef<{ page: PDFPageProxy; width: number }>(null);
  const { document: pdf, index, width, paintWidth, onSize, onError } = props;
  const ready = loaded?.pdf === pdf ? loaded : null;
  // A load that has started keeps going when its page leaves the view mid-drag.
  const [started, setStarted] = useState(false);
  const waiting = !started && props.defer;
  if (!started && !waiting) setStarted(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load the pdf.js page, its text layer and links once per mounted page, and release its resources when it leaves the virtual window.
  useEffect(() => {
    if (waiting) return;
    let cancelled = false;
    let fetched: PDFPageProxy | undefined;
    let textLayer: TextLayer | undefined;
    void (async () => {
      const page = await pdf.getPage(index + 1);
      fetched = page;
      if (cancelled || !text.current) {
        page.cleanup();
        return;
      }
      const natural = page.getViewport({ scale: 1 });
      onSize(index, natural.height / natural.width);
      text.current.replaceChildren();
      textLayer = new TextLayer({
        container: text.current,
        viewport: natural,
        textContentSource: page.streamTextContent(),
      });
      setLoaded({ pdf, page, layer: textLayer, natural });
      const linked = page.getAnnotations({ intent: "display" }).then(async (annotations) => {
        const found: PdfLink[] = [];
        for (const annotation of annotations) {
          if (annotation.subtype !== "Link") continue;
          const [x1, y1] = natural.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
          const [x2, y2] = natural.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
          const box = [
            Math.min(x1, x2) / natural.width,
            Math.min(y1, y2) / natural.height,
            Math.abs(x2 - x1) / natural.width,
            Math.abs(y2 - y1) / natural.height,
          ] as const;
          if (typeof annotation.url === "string" && /^https?:\/\//i.test(annotation.url)) {
            found.push({ box, url: annotation.url });
            continue;
          }
          const target = await pdfLinkPage(pdf, annotation.dest).catch(() => null);
          if (target !== null && target >= 0 && target < pdf.numPages)
            found.push({ box, page: target });
        }
        if (!cancelled) setLinks(found);
      });
      // A page whose annotations cannot be read still renders, without links.
      await Promise.all([textLayer.render(), linked.catch(() => undefined)]);
    })().catch((cause: unknown) => {
      if (!cancelled)
        onError(thrownErrorMessage(cause, m) ?? m(msg("This PDF page could not render.")));
    });
    return () => {
      cancelled = true;
      textLayer?.cancel();
      // pdf.js defers this until a running paint ends; it drops the page's operator lists.
      fetched?.cleanup();
    };
  }, [text, pdf, index, waiting, onSize, onError]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Paint the canvas at the settled width off screen and swap it in whole; CSS scales the old paint until then.
  useEffect(() => {
    if (!ready) return;
    const { page, layer, natural } = ready;
    if (painted.current?.page === page && painted.current.width === paintWidth) return;
    let cancelled = false;
    const failed = (cause: unknown) => {
      if (!cancelled)
        onError(thrownErrorMessage(cause, m) ?? m(msg("This PDF page could not render.")));
    };
    // Resizing a canvas blanks it, so the page paints off screen and replaces the old one whole.
    const buffer = document.createElement("canvas");
    let viewport: PageViewport;
    let paint: ReturnType<PDFPageProxy["render"]>;
    try {
      viewport = page.getViewport({ scale: paintWidth / natural.width });
      const ratio = Math.min(
        2,
        window.devicePixelRatio || 1,
        Math.sqrt((8 * 1024 * 1024) / (viewport.width * viewport.height)),
      );
      buffer.width = Math.ceil(viewport.width * ratio);
      buffer.height = Math.ceil(viewport.height * ratio);
      paint = page.render({
        canvas: buffer,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
        background: "white",
      });
    } catch (cause) {
      failed(cause);
      return;
    }
    paint.promise
      .then(() => {
        if (cancelled || !canvas.current) return;
        canvas.current.width = buffer.width;
        canvas.current.height = buffer.height;
        canvas.current.getContext("2d", { alpha: false })?.drawImage(buffer, 0, 0);
        buffer.width = 0;
        layer.update({ viewport });
        painted.current = { page, width: paintWidth };
      })
      .catch(failed);
    return () => {
      cancelled = true;
      paint.cancel();
    };
  }, [canvas, ready, paintWidth, onError]);
  return {
    links,
    textStyle: {
      "--total-scale-factor": ready
        ? (paintWidth / ready.natural.width) * ready.natural.userUnit
        : undefined,
      transform: `scale(${width / paintWidth})`,
    } as CSSProperties,
  };
}
