import { getDocument, PDFWorker } from "pdfjs-dist";

const IDLE_MS = 5 * 60_000;
let worker: PDFWorker | null = null;
let open = 0;
let idle: ReturnType<typeof setTimeout> | undefined;

// One pdf.js worker serves every document, so later opens and reloads reuse it instead of
// starting their own. It starts with the first document and ends five minutes after the last
// one closes.
export function getDocumentOnSharedWorker(params: Parameters<typeof getDocument>[0]) {
  clearTimeout(idle);
  worker ??= new PDFWorker();
  open++;
  const task = getDocument({ ...params, worker });
  let closed = false;
  return {
    promise: task.promise,
    destroy() {
      if (!closed && --open === 0)
        idle = setTimeout(() => {
          worker?.destroy();
          worker = null;
        }, IDLE_MS);
      closed = true;
      return task.destroy();
    },
  };
}
