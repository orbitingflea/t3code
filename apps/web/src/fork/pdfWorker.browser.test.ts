import { expect, it, vi } from "vite-plus/test";

vi.mock(import("pdfjs-dist/build/pdf.worker.min.mjs?url"), async () => {
  const { default: source } = await import("pdfjs-dist/build/pdf.worker.min.mjs?raw");
  return {
    default: URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
  };
});

import { fakeTimers, stubGlobal } from "../../test/render";
import { openPdf } from "~/components/files/pdfDocument";

function onePagePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
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
  return new TextEncoder().encode(source).buffer;
}

it("shares one pdf.js worker and ends it five minutes after the last PDF closes", async () => {
  const workers = { started: 0, ended: 0 };
  using _worker = stubGlobal(
    "Worker",
    class extends Worker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        workers.started++;
      }
      override terminate() {
        workers.ended++;
        super.terminate();
      }
    },
  );
  const first = openPdf(onePagePdf());
  const second = openPdf(onePagePdf());
  expect((await first.promise).numPages).toBe(1);
  expect((await second.promise).numPages).toBe(1);
  expect(workers).toEqual({ started: 1, ended: 0 });

  using _timers = fakeTimers();
  await first.destroy();
  vi.advanceTimersByTime(5 * 60_000);
  expect(workers.ended).toBe(0);

  await second.destroy();
  vi.advanceTimersByTime(4 * 60_000);
  const reopened = openPdf(onePagePdf());
  expect((await reopened.promise).numPages).toBe(1);
  vi.advanceTimersByTime(5 * 60_000);
  expect(workers).toEqual({ started: 1, ended: 0 });

  await reopened.destroy();
  await reopened.destroy();
  vi.advanceTimersByTime(5 * 60_000 - 1);
  expect(workers.ended).toBe(0);
  vi.advanceTimersByTime(1);
  expect(workers).toEqual({ started: 1, ended: 1 });

  const fresh = openPdf(onePagePdf());
  expect((await fresh.promise).numPages).toBe(1);
  expect(workers).toEqual({ started: 2, ended: 1 });
  await fresh.destroy();
});
