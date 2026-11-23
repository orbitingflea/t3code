import { expect, it } from "vite-plus/test";
import { pdfPageOffsets } from "~/components/files/pdfLayout";
import { pdfPlaceAt, pdfPlaceTop } from "./usePdfResize";

const ratios = [1.5, 1.5, 1.5];

it("scales a spot inside a page with the page width and keeps the gap above it", () => {
  const before = pdfPageOffsets(ratios, 400);
  const after = pdfPageOffsets(ratios, 200);
  const inside = pdfPlaceAt(before, ratios.length, before[1]! + 300, 400);
  expect(inside).toEqual({ page: 1, offset: 300, width: 400 });
  expect(pdfPlaceTop(inside, after, 200, 100)).toBe(after[1]! + 150);
  const gap = pdfPlaceAt(before, ratios.length, before[1]! - 10, 400);
  expect(gap).toEqual({ page: 1, offset: -10, width: 400 });
  expect(pdfPlaceTop(gap, after, 200, 100)).toBe(after[1]! - 10);
});

it("stops at the end of the column the viewer renders", () => {
  const before = pdfPageOffsets(ratios, 400);
  const after = pdfPageOffsets(ratios, 100);
  const place = pdfPlaceAt(before, ratios.length, before[2]! + 500, 400);
  // The column is one viewport plus the pages above the last one tall, so the view can always
  // start at the last page's top.
  expect(pdfPlaceTop(place, after, 100, 1000)).toBe(after[2]! - 16);
  expect(pdfPlaceTop(place, after, 100, 50)).toBe(after[3]! - 50);
  // The browser's scroll end is a whole pixel at or below the column's fractional end.
  expect(pdfPlaceTop(place, after, 100, 50.5)).toBe(after[3]! - 51);
});

it("keeps a spot inside its page when the page measures shorter", () => {
  const before = pdfPageOffsets(ratios, 400);
  const place = pdfPlaceAt(before, ratios.length, before[1]! + 500, 400);
  // Page 1 turns out to be a short banner: the spot stays on it, one pixel above its end.
  const after = pdfPageOffsets([1.5, 0.25, 1.5], 400);
  expect(pdfPlaceTop(place, after, 400, 100)).toBe(after[2]! - 16 - 1);
});
