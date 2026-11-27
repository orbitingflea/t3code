import { VirtualizedFile } from "@pierre/diffs";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type ChatFileAttachment, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { useClosedViewStore } from "~/closedViewStore";
import { useRightPanelStore } from "~/rightPanelStore";

vi.mock(import("~/assets/assetUrls"), async (original) =>
  (await import("./fileReadingTestMocks")).mockAssetUrls(await original()),
);
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) =>
  (await import("./fileReadingTestMocks")).mockRuntime(await original()),
);
vi.mock(import("~/state/session"), async (original) =>
  (await import("./fileReadingTestMocks")).mockSession(await original()),
);
vi.mock(import("~/state/filesystem"), async (original) =>
  (await import("./fileReadingTestMocks")).mockFilesystem(await original()),
);
vi.mock(import("~/state/use-atom-command"), async (original) =>
  (await import("./fileReadingTestMocks")).mockAtomCommand(await original()),
);
vi.mock(import("~/state/server"), async (original) =>
  (await import("./fileReadingTestMocks")).mockServer(await original()),
);
vi.mock(import("~/remoteOpen"), async (original) =>
  (await import("./fileReadingTestMocks")).mockRemoteOpen(await original()),
);
vi.mock(import("~/hooks/useTheme"), async (original) =>
  (await import("./fileReadingTestMocks")).mockTheme(await original()),
);
vi.mock(import("./projectFilesQueryState"), async (original) =>
  (await import("./fileReadingTestMocks")).mockProjectFiles(await original()),
);
vi.mock(import("~/hooks/useWorkspaceMutationRefresh"), async () =>
  (await import("./fileReadingTestMocks")).mockPanelParts.mutationRefresh(),
);
vi.mock(import("./FileBreadcrumbs"), async () =>
  (await import("./fileReadingTestMocks")).mockPanelParts.breadcrumbs(),
);
vi.mock(import("./FileBrowserPanel"), async () =>
  (await import("./fileReadingTestMocks")).mockPanelParts.browser(),
);
vi.mock(import("../DiffWorkerPoolProvider"), async () =>
  (await import("./fileReadingTestMocks")).mockPanelParts.diffWorkers(),
);

import { pathReadingKey } from "./fileReadingPosition";
import { readings } from "./fileReadingSave";
import { createFileReadingStore } from "./fileReadingStore";
import {
  AttachmentPanel,
  COLD_WORKER,
  csv,
  environmentId,
  holdIndexing,
  LARGE_TEXT_BYTES,
  largeText,
  lines,
  ReadingPanel,
  readingSetup,
  rowsView,
  sourceFile,
  sourceView,
  state,
} from "./fileReadingTestKit";
import { FILE_LINK_REVEAL_ATTRIBUTE } from "./fileSurfaceChrome";

/** Downloads a test feeds piece by piece, by URL. Effect's fetch client keeps the first fetch it sees. */
const fedDownloads = new Map<string, ReadableStream<Uint8Array>>();
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const body = [...fedDownloads].find(([prefix]) => url.startsWith(prefix))?.[1];
  return body === undefined ? nativeFetch(input, init) : Promise.resolve(new Response(body));
};

/** Serves a large text file whose full text arrives as `send` feeds it, after `preview`; `end` ends it. */
function feedLargeText(
  reading: { readonly cwd: string },
  path: string,
  preview: string,
  size: number,
) {
  const url = `https://download.test/${path}`;
  const encoder = new TextEncoder();
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  // The download starts with the part the panel already read.
  fedDownloads.set(
    url,
    new ReadableStream({
      start: (controller) => {
        feed = controller;
        controller.enqueue(encoder.encode(preview));
      },
    }),
  );
  state.assets[`${reading.cwd}/${path}`] = `${url}#asset`;
  state.files[path] = { relativePath: path, contents: preview, byteLength: size, truncated: true };
  return {
    send: (text: string) => feed.enqueue(encoder.encode(text)),
    end() {
      if (open) feed.close();
      open = false;
    },
    [Symbol.dispose]() {
      fedDownloads.delete(url);
      this.end();
    },
  };
}

/** More than a code view's own line measuring moves its height: hundreds of lines arrived. */
const GROWN_PX = 1000;

/** How far `line`'s middle sits from the code view's middle, if the line is drawn. */
function offCenter(view: ReturnType<typeof sourceView>, line: number) {
  const row = view.line(line);
  if (row === null) return Number.POSITIVE_INFINITY;
  const drawn = row.getBoundingClientRect();
  const box = view.scroller().getBoundingClientRect();
  return Math.abs(drawn.top + drawn.height / 2 - (box.top + view.scroller().clientHeight / 2));
}

describe("file reading position", () => {
  it("returns a source file to the reader's line after a tab switch and a panel remount", async () => {
    using reading = await readingSetup("switch");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "a.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"));
    await userEvent.wheel(view.scroller(), { delta: { y: 1213 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(50));
    const before = view.topLine();
    expect(before.offset).toBeLessThan(0);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:a.ts"));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before));

    await screen.rerender(<></>);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    await vi.waitFor(() => expect(view.topLine()).toEqual(before));
  });

  it("shows a read-only file's cited line again when the panel remounts", async () => {
    using reading = await readingSetup("read-only-citation");
    const { panel, ref } = reading;
    state.files["/outside/a.ts"] = sourceFile("/outside/a.ts", "alpha", 300);
    panel.openFile(ref, "/outside/a.ts", 150);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(150, "alpha_150"), COLD_WORKER);

    await screen.rerender(<></>);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    await vi.waitFor(() => view.expectLineInView(150, "alpha_150"), COLD_WORKER);
  });

  it("reveals a citation over a saved position, then keeps the reader's later place", async () => {
    using reading = await readingSetup("cited");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "a.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"));
    await userEvent.wheel(view.scroller(), { delta: { y: 3000 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(100));

    await act(() => panel.openFile(ref, "a.ts", 40));
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:a.ts"));
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
    expect(reading.saved("a.ts", "source")?.line).toBe(40);
    await userEvent.wheel(view.scroller(), { delta: { y: 230 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(40));
    const before = view.topLine();
    expect(before.line).toBeLessThan(100);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.openFile(ref, "c.ts"));
    await act(() => panel.closeSurface(ref, "file:c.ts"));
    await act(() => panel.activateSurface(ref, "file:a.ts"));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before));
    expect(view.line(40)?.hasAttribute(FILE_LINK_REVEAL_ATTRIBUTE)).toBe(true);
  });

  it("clamps a saved position past the end of shorter contents without rewriting it", async () => {
    using reading = await readingSetup("shorter");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "a.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"));
    await userEvent.wheel(view.scroller(), { delta: { y: 4000 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(150));
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    const saved = reading.saved("a.ts", "source");

    state.files["a.ts"] = sourceFile("a.ts", "alpha", 60);
    await act(() => panel.activateSurface(ref, "file:a.ts"));
    await vi.waitFor(() => view.expectLineInView(60, "alpha_60"));
    const scroller = view.scroller();
    expect(scroller.scrollTop).toBeGreaterThanOrEqual(
      scroller.scrollHeight - scroller.clientHeight - 1,
    );
    expect(reading.saved("a.ts", "source")).toEqual(saved);
  });

  it("saves the last line an editable file showed for a citation past its end, also after it grows", async () => {
    using reading = await readingSetup("editor-stale-citation");
    const { panel, ref, cwd } = reading;
    state.files["a.ts"] = sourceFile("a.ts", "alpha", 100);
    panel.openFile(ref, "a.ts", 250);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(100, "alpha_100"), COLD_WORKER);
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBe(100));

    await screen.rerender(<></>);
    state.files["a.ts"] = sourceFile("a.ts", "alpha", 300);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={cwd} />);
    await vi.waitFor(() => view.expectLineInView(100, "alpha_100"), COLD_WORKER);
    expect(reading.saved("a.ts", "source")?.line).toBe(100);
  });

  it("returns a citation reopened with Reopen Closed View to the reader's place", async () => {
    using reading = await readingSetup("reopen-closed");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "a.ts", 40);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
    await userEvent.wheel(view.scroller(), { delta: { y: 2000 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(100));
    const before = view.topLine();

    await act(() => panel.closeSurface(ref, "file:a.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    const entry = useClosedViewStore
      .getState()
      .entries.find((closed) => closed.kind === "panel-tab" && closed.surface.id === "file:a.ts")!;
    // Reopen Closed View opens the tab with its old line, then drops the closed entry after an await.
    panel.openFile(ref, "a.ts", 40);
    await Promise.resolve();
    useClosedViewStore.getState().remove(entry.id);

    await vi.waitFor(() => expect(view.topLine()).toEqual(before));
    expect(view.line(40)).toBeNull();
  });

  it("shows an unscrolled read-only citation in wrapped lines again after Reopen Closed View", async () => {
    using reading = await readingSetup("reopen-closed-read-only-wrapped");
    const { panel, ref } = reading;
    // Lines that wrap to different heights, which a new code view only estimates at first.
    const contents = Array.from(
      { length: 300 },
      (_, index) =>
        `const alpha_${index + 1} = "${"wrapped words ".repeat(2 + ((index * 7) % 9))}";`,
    ).join("\n");
    state.files["/outside/a.ts"] = {
      relativePath: "/outside/a.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "/outside/a.ts", 150);
    await using screen = await render(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />,
    );
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(150, "alpha_150"), COLD_WORKER);

    await act(() => panel.closeSurface(ref, "file:/outside/a.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    const entry = useClosedViewStore
      .getState()
      .entries.find(
        (closed) => closed.kind === "panel-tab" && closed.surface.id === "file:/outside/a.ts",
      )!;
    panel.openFile(ref, "/outside/a.ts", 150);
    await Promise.resolve();
    useClosedViewStore.getState().remove(entry.id);

    await vi.waitFor(() => view.expectLineInView(150, "alpha_150"), COLD_WORKER);
  });

  it("keeps a read-only reader's place over two tab switches after the citation landed", async () => {
    using reading = await readingSetup("read-only-two-switches");
    const { panel, ref } = reading;
    state.files["/outside/a.ts"] = sourceFile("/outside/a.ts", "alpha", 300);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "/outside/a.ts", 150);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(150, "alpha_150"), COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 2000 } });
    await vi.waitFor(() => expect(view.line(150)).toBeNull());
    const before = view.topLine();

    for (let round = 0; round < 2; round += 1) {
      await act(() => panel.activateSurface(ref, "file:b.ts"));
      await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
      await act(() => panel.activateSurface(ref, "file:/outside/a.ts"));
      await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
    }
    expect(view.line(150)).toBeNull();
  });

  it("shows a read-only citation on return when the reader switched tabs before it landed", async () => {
    using reading = await readingSetup("read-only-early-switch");
    const { panel, ref } = reading;
    state.files["/outside/a.ts"] = sourceFile("/outside/a.ts", "alpha", 300);
    panel.openFile(ref, "b.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"), COLD_WORKER);
    // Switch away as soon as the code view starts its scroll to the line, before it settles.
    const scrollToLine = VirtualizedFile.prototype.scrollToLine;
    let switched = false;
    using _restore = {
      [Symbol.dispose]: () => {
        VirtualizedFile.prototype.scrollToLine = scrollToLine;
      },
    };
    VirtualizedFile.prototype.scrollToLine = function (...args) {
      const result = scrollToLine.apply(this, args);
      if (!switched) {
        switched = true;
        panel.activateSurface(ref, "file:b.ts");
      }
      return result;
    };
    await act(() => panel.openFile(ref, "/outside/a.ts", 150));
    await vi.waitFor(() => expect(switched).toBe(true), COLD_WORKER);
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));

    await act(() => panel.activateSurface(ref, "file:/outside/a.ts"));
    await vi.waitFor(() => view.expectLineInView(150, "alpha_150"), COLD_WORKER);
  });

  it("jumps to a Markdown citation reopened at request 1 after it was read rendered", async () => {
    using reading = await readingSetup("reopen-md");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "doc.md", 40);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => expect(view.line(40)).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Show rendered markdown" }));
    await vi.waitFor(() => expect(screen.container.querySelector(".chat-markdown")).toBeTruthy());

    await act(() => panel.closeSurface(ref, "file:doc.md"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.openFile(ref, "doc.md", 40));

    await vi.waitFor(() => expect(screen.container.querySelector(".chat-markdown")).toBeFalsy());
    await vi.waitFor(() =>
      expect(view.line(40)?.hasAttribute(FILE_LINK_REVEAL_ATTRIBUTE)).toBe(true),
    );
    const scroller = view.scroller();
    const line = view.line(40)!.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    expect(line.top).toBeGreaterThanOrEqual(box.top);
    expect(line.bottom).toBeLessThanOrEqual(box.bottom);
  });

  it("jumps to a citation reopened at request 1 after its tab was closed", async () => {
    using reading = await readingSetup("reopen");
    const panel = useRightPanelStore.getState();
    panel.openFile(reading.ref, "b.ts");
    panel.openFile(reading.ref, "a.ts", 40);
    await using screen = await render(<ReadingPanel threadRef={reading.ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
    const revealedTop = view.scroller().scrollTop;
    await userEvent.wheel(view.scroller(), { delta: { y: 2000 } });
    await vi.waitFor(() => expect(view.scroller().scrollTop).toBeGreaterThan(revealedTop + 1000));

    await act(() => panel.closeSurface(reading.ref, "file:a.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.openFile(reading.ref, "a.ts", 40));

    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
  });

  it("jumps to a new citation of a read-only file reopened after its tab was closed", async () => {
    using reading = await readingSetup("reopen-read-only");
    const panel = useRightPanelStore.getState();
    state.files["/outside/a.ts"] = sourceFile("/outside/a.ts", "alpha", 300);
    panel.openFile(reading.ref, "b.ts");
    panel.openFile(reading.ref, "/outside/a.ts", 40);
    await using screen = await render(<ReadingPanel threadRef={reading.ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"), COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 1500 } });
    await vi.waitFor(() => expect(view.line(40)).toBeNull());

    await act(() => panel.closeSurface(reading.ref, "file:/outside/a.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.openFile(reading.ref, "/outside/a.ts", 225));

    await vi.waitFor(() => view.expectLineInView(225, "alpha_225"), COLD_WORKER);
  });
});

describe("read-only files keep the reader's place", () => {
  const readOnly = (path: string, contents: string) => {
    state.files[path] = {
      relativePath: path,
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    return pathReadingKey(environmentId, path);
  };
  /** The source place the store wrote, which it does once the reader's scroll comes to rest. */
  const written = (path: string) =>
    localStorage.getItem(
      `t3code.fileReading.v1:${JSON.stringify([environmentId, path, "source"])}`,
    );

  it("returns a read-only file to the reader's line 150 after a tab switch and a panel remount", async () => {
    using reading = await readingSetup("read-only-line-150");
    const { panel, ref } = reading;
    // Saved places outlive a test, so this test reads a file no other test opens.
    const path = "/outside/remount.ts";
    const file = readOnly(path, sourceFile(path, "alpha", 300).contents);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"), COLD_WORKER);
    const rowHeight = view.line(1)!.getBoundingClientRect().height;
    await userEvent.wheel(view.scroller(), { delta: { y: Math.round(rowHeight * 149.4) } });
    await vi.waitFor(() => expect(view.topLine().line).toBe(150));
    await vi.waitFor(() => expect(written(path)).not.toBeNull());
    const before = view.topLine();

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);

    await screen.rerender(<></>);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
    expect(readings.readPosition(file, "source")?.line).toBe(150);
  });

  it("returns a read-only file of wrapped lines to the reader's exact place", async () => {
    using reading = await readingSetup("read-only-wrapped-place");
    const { panel, ref } = reading;
    const path = "/outside/wrapped.ts";
    // Lines that wrap to different heights, which a new code view only estimates at first.
    const file = readOnly(
      path,
      Array.from(
        { length: 300 },
        (_, index) =>
          `const alpha_${index + 1} = "${"wrapped words ".repeat(2 + ((index * 7) % 9))}";`,
      ).join("\n"),
    );
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path);
    await using screen = await render(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />,
    );
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1 "), COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 4321 } });
    await vi.waitFor(() => expect(written(path)).not.toBeNull());
    expect(readings.readPosition(file, "source")?.line).toBeGreaterThan(40);
    const before = view.topLine();
    expect(before.offset).toBeLessThan(0);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);

    await screen.rerender(<></>);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />);
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
  });

  it("returns a read-only file of wrapped lines to the reader's place after a long scroll back up", async () => {
    using reading = await readingSetup("read-only-wrapped-up");
    const { panel, ref } = reading;
    const path = "/outside/wrapped-up.ts";
    readOnly(
      path,
      Array.from(
        { length: 300 },
        (_, index) =>
          `const alpha_${index + 1} = "${"wrapped words ".repeat(2 + ((index * 7) % 9))}";`,
      ).join("\n"),
    );
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path);
    await using screen = await render(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />,
    );
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1 "), COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 12_000 } });
    await vi.waitFor(() => expect(view.topLine().line).toBeGreaterThan(150));
    await userEvent.wheel(view.scroller(), { delta: { y: -9000 } });
    await vi.waitFor(() => expect(view.topLine().line).toBeLessThan(100));
    await vi.waitFor(() => expect(JSON.parse(written(path) ?? "{}").line).toBeLessThan(100));
    const before = view.topLine();

    await screen.rerender(<></>);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />);
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
  });

  it("keeps a read-only reader's place inside a last line taller than the view", async () => {
    using reading = await readingSetup("read-only-tall-last-line");
    const { panel, ref } = reading;
    const path = "/outside/tall.ts";
    readOnly(
      path,
      [
        ...Array.from({ length: 20 }, (_, index) => `const alpha_${index + 1} = ${index + 1};`),
        `const tall = "${"wrapped words ".repeat(1500)}";`,
      ].join("\n"),
    );
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path);
    await using screen = await render(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />,
    );
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1 "), COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 3000 } });
    await vi.waitFor(() => expect(view.topLine().line).toBe(21));
    await vi.waitFor(() => expect(JSON.parse(written(path) ?? "{}").line).toBe(21));
    const before = view.topLine();
    expect(before.offset).toBeLessThan(-400);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
  });

  it("keeps a read-only reader's last scroll when the tab switches before it is read", async () => {
    using reading = await readingSetup("read-only-fast-switch");
    const { panel, ref } = reading;
    const path = "/outside/fast.ts";
    readOnly(path, sourceFile(path, "alpha", 300).contents);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"), COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 1500 } });
    await vi.waitFor(() => expect(written(path)).not.toBeNull());

    // One more scroll, and the tab switch in the same task, before a frame can read it.
    const scroller = view.scroller();
    const top = scroller.scrollTop + 220;
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 220, bubbles: true }));
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event("scroll"));
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(() => expect(view.scroller().scrollTop).toBe(top), COLD_WORKER);
  });

  it("saves a read-only reader's last scroll when the page hides before it is read", async () => {
    using reading = await readingSetup("read-only-page-hide");
    const { panel, ref } = reading;
    const path = "/outside/hide.ts";
    const file = readOnly(path, sourceFile(path, "alpha", 300).contents);
    panel.openFile(ref, path);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"), COLD_WORKER);
    const rowHeight = view.line(1)!.getBoundingClientRect().height;
    await userEvent.wheel(view.scroller(), { delta: { y: Math.round(rowHeight * 50) } });
    await vi.waitFor(() => expect(written(path)).not.toBeNull());

    // A reload hides the page after the reader's last scroll, before a frame can read it.
    const scroller = view.scroller();
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 220, bubbles: true }));
    scroller.scrollTop = Math.round(rowHeight * 100);
    scroller.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    expect(JSON.parse(written(path) ?? "{}").line).toBe(100);
    expect(readings.readPosition(file, "source")?.line).toBe(100);
  });

  it("finishes a read-only restore of wrapped lines when the page comes back from the back-forward cache", async () => {
    using reading = await readingSetup("read-only-page-cache");
    const { panel, ref } = reading;
    const path = "/outside/page-cache.ts";
    const file = readOnly(
      path,
      Array.from(
        { length: 1200 },
        (_, index) =>
          `const uneven_${index + 1} = "${"wrapped text ".repeat(2 + ((index * 13) % 29))}";`,
      ).join("\n"),
    );
    readings.writePosition(file, { view: "source", line: 750, offset: 7 });
    panel.openFile(ref, path);
    const shown = () => <ReadingPanel threadRef={ref} cwd={reading.cwd} width={370} />;
    await using screen = await render(shown());
    const view = sourceView(screen.container);
    await vi.waitFor(() => expect(view.topLine()).toEqual({ line: 750, offset: -7 }), COLD_WORKER);
    await screen.rerender(<></>);

    // The page goes into the back-forward cache as the restore starts to scroll, then comes back.
    let hidden = false;
    const hideOnScroll = (event: Event) => {
      const target = event.target;
      if (hidden || !(target instanceof HTMLElement) || target.scrollTop === 0) return;
      if (!target.matches(".file-preview-virtualizer")) return;
      hidden = true;
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    };
    document.addEventListener("scroll", hideOnScroll, true);
    using _listener = {
      [Symbol.dispose]: () => document.removeEventListener("scroll", hideOnScroll, true),
    };
    await screen.rerender(shown());
    await vi.waitFor(() => expect(hidden).toBe(true), COLD_WORKER);
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await vi.waitFor(() => expect(view.topLine()).toEqual({ line: 750, offset: -7 }), COLD_WORKER);
  });

  it("keeps a read-only reader's place after the reader cut a citation's scroll short", async () => {
    using reading = await readingSetup("read-only-cut-citation");
    const { panel, ref } = reading;
    const path = "/outside/cut.ts";
    readOnly(path, sourceFile(path, "alpha", 300).contents);
    panel.openFile(ref, "b.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"), COLD_WORKER);
    // The reader's wheel reaches the code view before its scroll to the cited line settles.
    const scrollToLine = VirtualizedFile.prototype.scrollToLine;
    const results: string[] = [];
    using _restore = {
      [Symbol.dispose]: () => {
        VirtualizedFile.prototype.scrollToLine = scrollToLine;
      },
    };
    VirtualizedFile.prototype.scrollToLine = function (line, align, onDone) {
      scrollToLine.call(this, line, align, (result) => {
        results.push(result);
        onDone(result);
      });
      if (results.length === 0) {
        view.scroller().dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true }));
      }
    };
    await act(() => panel.openFile(ref, path, 150));
    await vi.waitFor(() => expect(results).toContain("cancelled"), COLD_WORKER);
    VirtualizedFile.prototype.scrollToLine = scrollToLine;
    await userEvent.wheel(view.scroller(), { delta: { y: 1500 } });
    await vi.waitFor(() => expect(written(path)).not.toBeNull(), COLD_WORKER);
    const before = view.topLine();

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
  });

  it("returns a read-only file of uneven wrapped lines to the place the reader measured", async () => {
    using reading = await readingSetup("read-only-uneven-wrap");
    const { panel, ref } = reading;
    const path = "/outside/uneven.ts";
    readOnly(
      path,
      Array.from(
        { length: 600 },
        (_, index) =>
          `const uneven_${index + 1} = "${"wrapped text ".repeat(2 + ((index * 13) % 19))}";`,
      ).join("\n"),
    );
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path);
    await using screen = await render(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />,
    );
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "uneven_1 "), COLD_WORKER);
    // A jump far past the rows the view has measured, then a short scroll on.
    await userEvent.wheel(view.scroller(), { delta: { y: 6500 } });
    await vi.waitFor(() => expect(written(path)).not.toBeNull());
    const at = JSON.parse(written(path)!).at;
    await userEvent.wheel(view.scroller(), { delta: { y: 63 } });
    await vi.waitFor(() => expect(JSON.parse(written(path)!).at).not.toBe(at));
    const before = view.topLine();

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
  });

  it("keeps a landed read-only citation in view when the panel comes back shorter", async () => {
    using reading = await readingSetup("read-only-shorter-panel");
    const { panel, ref } = reading;
    const path = "/outside/shorter.ts";
    readOnly(path, sourceFile(path, "alpha", 600).contents);
    panel.openFile(ref, path);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"), COLD_WORKER);
    // A tall panel centers the citation far below the top of a shorter one.
    const tall = screen.container.firstElementChild as HTMLElement;
    tall.style.height = "750px";
    await vi.waitFor(() => expect(view.scroller().clientHeight).toBeGreaterThan(650));
    /** How far line 250's middle sits from the viewport's middle. */
    const offCenter = () => {
      const line = view.line(250)!.getBoundingClientRect();
      const box = view.scroller().getBoundingClientRect();
      return Math.abs(line.top + line.height / 2 - (box.top + view.scroller().clientHeight / 2));
    };
    await act(() => panel.openFile(ref, path, 250));
    await vi.waitFor(() => expect(offCenter()).toBeLessThan(2), COLD_WORKER);
    await vi.waitFor(() => expect(JSON.parse(written(path) ?? "{}").line).toBe(250));

    await screen.rerender(<></>);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    await vi.waitFor(() => expect(view.scroller().clientHeight).toBeLessThan(400), COLD_WORKER);
    await vi.waitFor(() => expect(offCenter()).toBeLessThan(2), COLD_WORKER);
  });

  it("centers a landed read-only citation again when its view comes back taller", async () => {
    using reading = await readingSetup("read-only-taller-panel");
    const { panel, ref } = reading;
    const path = "/outside/taller.ts";
    readOnly(path, sourceFile(path, "alpha", 600).contents);
    panel.openFile(ref, path, 250);
    const sized = (height: number) => (
      <div data-sized style={{ height }}>
        <style>{"[data-sized] > div { height: inherit !important; }"}</style>
        <ReadingPanel threadRef={ref} cwd={reading.cwd} />
      </div>
    );
    await using screen = await render(sized(400));
    const view = sourceView(screen.container);
    /** How far line 250's middle sits from the viewport's middle. */
    const offCenter = () => {
      const line = view.line(250)!.getBoundingClientRect();
      const box = view.scroller().getBoundingClientRect();
      return Math.abs(line.top + line.height / 2 - (box.top + view.scroller().clientHeight / 2));
    };
    await vi.waitFor(() => expect(offCenter()).toBeLessThan(2), COLD_WORKER);
    await vi.waitFor(() => expect(JSON.parse(written(path) ?? "{}").line).toBe(250));
    const before = view.scroller().clientHeight;

    // The viewer is built again in a taller view, as when the theme changes after the panel grew.
    await screen.rerender(<></>);
    await screen.rerender(sized(650));
    await vi.waitFor(
      () => expect(view.scroller().clientHeight).toBeGreaterThan(before + 200),
      COLD_WORKER,
    );
    await vi.waitFor(() => expect(offCenter()).toBeLessThan(2), COLD_WORKER);
  });

  it("keeps a wrapped read-only citation centered when the viewer is built again", async () => {
    using reading = await readingSetup("read-only-wrapped-citation");
    const { panel, ref } = reading;
    const path = "/outside/wrapped-citation.ts";
    const contents = sourceFile(path, "alpha", 600).contents.split("\n");
    contents[449] = `const wrapped = "${"wrapped text ".repeat(16)}";`;
    readOnly(path, contents.join("\n"));
    panel.openFile(ref, path, 450);
    const shown = () => <ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />;
    await using screen = await render(shown());
    const view = sourceView(screen.container);
    /** Line 450's middle against the viewport's middle, with the sizes it was measured at. */
    const center = () => {
      const row = view.line(450)!.getBoundingClientRect();
      const scroller = view.scroller();
      const box = scroller.getBoundingClientRect();
      return {
        offset: Math.round(row.top + row.height / 2 - box.top - scroller.clientHeight / 2),
        rowHeight: row.height,
        viewHeight: scroller.clientHeight,
      };
    };
    await vi.waitFor(() => expect(Math.abs(center().offset)).toBeLessThan(2), COLD_WORKER);
    await vi.waitFor(() => expect(JSON.parse(written(path) ?? "{}").line).toBe(450));
    const before = center();
    // The cited line wraps to several rows, which a new viewer first estimates as one.
    expect(before.rowHeight).toBeGreaterThan(40);
    expect(before.rowHeight).toBeLessThan(before.viewHeight / 2);

    await screen.rerender(<></>);
    await screen.rerender(shown());
    await vi.waitFor(() => expect(center()).toEqual(before), COLD_WORKER);
  });

  it("restores a place on the cited line that another browser tab saved later", async () => {
    using reading = await readingSetup("read-only-other-tab");
    const { panel, ref } = reading;
    const path = "/outside/other-tab.ts";
    const file = readOnly(path, sourceFile(path, "alpha", 600).contents);
    panel.openFile(ref, path, 300);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(300, "alpha_300"), COLD_WORKER);
    await vi.waitFor(() => expect(JSON.parse(written(path) ?? "{}").line).toBe(300));
    const landed = JSON.parse(written(path)!);
    await screen.rerender(<></>);

    // Another browser tab shares the storage but has its own store.
    const otherTab = createFileReadingStore({
      storage: () => window.localStorage,
      now: () => landed.at + 1,
    });
    otherTab.writePosition(file, { view: "source", line: 300, offset: 7 });

    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    await vi.waitFor(() => expect(view.topLine()).toEqual({ line: 300, offset: -7 }), COLD_WORKER);
  });

  it("keeps a read-only reader's first scroll made before a new citation's reveal ran", async () => {
    using reading = await readingSetup("read-only-first-scroll-before-reveal");
    const { panel, ref } = reading;
    const path = "/outside/first-scroll-before-reveal.ts";
    const file = readOnly(path, sourceFile(path, "alpha", 600).contents);
    panel.openFile(ref, path);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(12, "alpha_12"), COLD_WORKER);
    expect(readings.readPosition(file, "source")).toBeNull();
    // With no place saved yet, the reader scrolls once the citation's mark shows, before its reveal.
    const scroller = view.scroller();
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const marked = new MutationObserver(() => {
      if (view.line(12)?.hasAttribute(FILE_LINK_REVEAL_ATTRIBUTE) !== true) return;
      marked.disconnect();
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 950, bubbles: true }));
      scroller.scrollTop = 950;
      scroller.dispatchEvent(new Event("scroll"));
    });
    marked.observe(root, { subtree: true, attributeFilter: [FILE_LINK_REVEAL_ATTRIBUTE] });
    using _observer = { [Symbol.dispose]: () => marked.disconnect() };
    await act(() => panel.openFile(ref, path, 12));
    await vi.waitFor(() => expect(written(path)).not.toBeNull(), COLD_WORKER);
    expect(scroller.scrollTop).toBe(950);
    expect(readings.readPosition(file, "source")?.centered).toBeUndefined();
  });

  it("keeps a cited read-only file's place when the store drops it while the panel is open", async () => {
    using reading = await readingSetup("read-only-dropped-place");
    const { panel, ref } = reading;
    const path = "/outside/dropped-place.ts";
    const file = readOnly(path, sourceFile(path, "alpha", 600).contents);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path, 40);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"), COLD_WORKER);
    await vi.waitFor(() => expect(readings.readPosition(file, "source")?.line).toBe(40));
    await userEvent.wheel(view.scroller(), { delta: { y: 3000 } });
    await vi.waitFor(() => expect(readings.readPosition(file, "source")?.centered).toBeUndefined());
    const before = view.topLine();

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    // Places saved in many other files push this one out of the store.
    for (let index = 0; index < 300; index += 1) {
      readings.writePosition(pathReadingKey(environmentId, `/outside/dropped-other-${index}.ts`), {
        view: "source",
        line: 2,
        offset: 0,
      });
    }
    expect(readings.readPosition(file, "source")).toBeNull();
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
  });

  it("returns a read-only file whose first line almost fills the view to its top", async () => {
    using reading = await readingSetup("read-only-near-full-first-line");
    const { panel, ref } = reading;
    const path = "/outside/near-full-first-line.ts";
    readOnly(path, `// ${"wrapped words ".repeat(60)}\n${sourceFile(path, "tail", 150).contents}`);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path);
    const sized = (height: number) => (
      <div data-sized style={{ height }}>
        <style>{"[data-sized] > div { height: inherit !important; }"}</style>
        <ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />
      </div>
    );
    await using screen = await render(sized(780));
    const view = sourceView(screen.container);
    const firstLine = () => view.line(1)?.getBoundingClientRect().height ?? 0;
    await vi.waitFor(() => expect(firstLine()).toBeGreaterThan(100), COLD_WORKER);
    // The view is 3 px taller than the first line, less than the rows' top padding.
    await screen.rerender(sized(780 - view.scroller().clientHeight + firstLine() + 3));
    const nearlyFull = () => expect(view.scroller().clientHeight - firstLine()).toBe(3);
    await vi.waitFor(nearlyFull, COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 500 } });
    await vi.waitFor(() => expect(view.scroller().scrollTop).toBe(500));
    await userEvent.wheel(view.scroller(), { delta: { y: -1000 } });
    await vi.waitFor(() => expect(JSON.parse(written(path) ?? "{}").offset).toBeLessThan(0));

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    // The restored view must not move off the top, also once its first line is measured.
    let moved = false;
    const watch = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.scrollTop !== 0) moved = true;
    };
    document.addEventListener("scroll", watch, true);
    using _watch = { [Symbol.dispose]: () => document.removeEventListener("scroll", watch, true) };
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(nearlyFull, COLD_WORKER);
    // The reader's wheel up at the top ends the restore.
    await userEvent.wheel(view.scroller(), { delta: { y: -100 } });
    expect(moved).toBe(false);
    expect(view.scroller().scrollTop).toBe(0);
  });

  it("shows a read-only citation again in a new panel after the store dropped its place", async () => {
    using reading = await readingSetup("read-only-new-panel-dropped");
    const { panel, ref } = reading;
    const path = "/outside/new-panel-dropped.ts";
    const file = readOnly(path, sourceFile(path, "alpha", 650).contents);
    panel.openFile(ref, path, 250);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(250, "alpha_250"), COLD_WORKER);
    await vi.waitFor(() => expect(readings.readPosition(file, "source")?.line).toBe(250));
    await screen.rerender(<></>);
    // Places saved in many other files push this one out of the store.
    for (let index = 0; index < 300; index += 1) {
      readings.writePosition(
        pathReadingKey(environmentId, `/outside/new-panel-other-${index}.ts`),
        {
          view: "source",
          line: 2,
          offset: 0,
        },
      );
    }
    expect(readings.readPosition(file, "source")).toBeNull();

    // A new panel has no pixel place of its own, so the tab's citation shows.
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    await vi.waitFor(() => view.expectLineInView(250, "alpha_250"), COLD_WORKER);
  });

  it("returns a file read in the editor to the same place when it opens read-only", async () => {
    using reading = await readingSetup("editor-then-read-only");
    const { panel, ref } = reading;
    const path = `${reading.cwd}/a.ts`;
    state.files[path] = sourceFile(path, "alpha", 300);
    panel.openFile(ref, "a.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"), COLD_WORKER);
    // The editor saves the first whole row below the viewport top, past the rows' padding.
    await userEvent.wheel(view.scroller(), { delta: { y: 1213 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.offset).toBeLessThan(-9));
    const before = view.topLine();
    await screen.rerender(<></>);

    // Another workspace opens the same file by its absolute path, read-only.
    const otherRef = scopeThreadRef(environmentId, ThreadId.make("reading-editor-then-read-only"));
    using _thread = { [Symbol.dispose]: () => panel.removeThread(otherRef) };
    await act(() => panel.openFile(otherRef, path));
    await screen.rerender(<ReadingPanel threadRef={otherRef} cwd="/outside" />);
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
  });

  it("returns the editor's place inside a long first line when the file opens read-only", async () => {
    using reading = await readingSetup("editor-tall-first-then-read-only");
    const { panel, ref } = reading;
    const path = `${reading.cwd}/a.ts`;
    const contents = `// ${"wrapped words ".repeat(160)}\n${sourceFile(path, "alpha", 300).contents}`;
    state.files["a.ts"] = {
      relativePath: "a.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    state.files[path] = { ...state.files["a.ts"]!, relativePath: path };
    panel.openFile(ref, "a.ts");
    await using screen = await render(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />,
    );
    const view = sourceView(screen.container);
    await vi.waitFor(() => expect(view.line(2)).not.toBeNull(), COLD_WORKER);
    // The reader is a little way into a first line taller than the view; the editor saves line 2.
    await userEvent.wheel(view.scroller(), { delta: { y: 12 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBe(2));
    const top = view.scroller().scrollTop;
    await screen.rerender(<></>);

    // Another workspace opens the same file by its absolute path, read-only.
    const otherRef = scopeThreadRef(environmentId, ThreadId.make("reading-editor-tall-first"));
    using _thread = { [Symbol.dispose]: () => panel.removeThread(otherRef) };
    await act(() => panel.openFile(otherRef, path));
    await screen.rerender(<ReadingPanel threadRef={otherRef} cwd="/outside" width={420} />);
    await vi.waitFor(() => {
      expect(view.line(1)!.getBoundingClientRect().height).toBeGreaterThan(
        view.scroller().clientHeight,
      );
      expect(Math.abs(view.scroller().scrollTop - top)).toBeLessThanOrEqual(1);
    }, COLD_WORKER);
  });

  it("returns the editor's place after a long scroll back up when the file opens read-only", async () => {
    using reading = await readingSetup("editor-scroll-up-then-read-only");
    const { panel, ref } = reading;
    const path = `${reading.cwd}/a.ts`;
    state.files["a.ts"] = sourceFile("a.ts", "alpha", 900);
    state.files[path] = { ...state.files["a.ts"]!, relativePath: path };
    panel.openFile(ref, "a.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"), COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 9000 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(400));
    const deep = JSON.stringify(reading.saved("a.ts", "source"));
    // A long scroll back up: the editor may save a line its rows have not moved off yet, far below.
    await userEvent.wheel(view.scroller(), { delta: { y: -6000 } });
    await vi.waitFor(() => expect(JSON.stringify(reading.saved("a.ts", "source"))).not.toBe(deep));
    const before = view.topLine();
    await screen.rerender(<></>);

    // Another workspace opens the same file by its absolute path, read-only.
    const otherRef = scopeThreadRef(environmentId, ThreadId.make("reading-editor-scroll-up"));
    using _thread = { [Symbol.dispose]: () => panel.removeThread(otherRef) };
    await act(() => panel.openFile(otherRef, path));
    await screen.rerender(<ReadingPanel threadRef={otherRef} cwd="/outside" />);
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
  });

  it("returns a read-only place deep inside a long wrapped line when the file opens in the editor", async () => {
    using reading = await readingSetup("read-only-deep-line-then-editor");
    const { panel, ref } = reading;
    const path = `${reading.cwd}/a.ts`;
    const file = pathReadingKey(environmentId, path);
    const rows = sourceFile(path, "alpha", 1500).contents.split("\n");
    rows[449] = `// ${"wrapped words ".repeat(1600)}`;
    const contents = rows.join("\n");
    state.files["a.ts"] = {
      relativePath: "a.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    state.files[path] = { ...state.files["a.ts"]!, relativePath: path };
    // Another workspace opens the file read-only by its absolute path, and the reader goes deep
    // into the long line, past what a new editor estimates for it.
    const otherRef = scopeThreadRef(environmentId, ThreadId.make("reading-deep-line-then-editor"));
    using _thread = { [Symbol.dispose]: () => panel.removeThread(otherRef) };
    await act(() => panel.openFile(otherRef, path, 450));
    await using screen = await render(
      <ReadingPanel threadRef={otherRef} cwd="/outside" width={420} />,
    );
    const view = sourceView(screen.container);
    await vi.waitFor(() => {
      expect(view.line(450)?.getBoundingClientRect().height ?? 0).toBeGreaterThan(4000);
      expect(readings.readPosition(file, "source")?.centered).toBe(true);
    }, COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 3200 } });
    await vi.waitFor(() =>
      expect(readings.readPosition(file, "source")?.offset).toBeGreaterThan(3000),
    );
    const before = view.topLine();
    expect(before.line).toBe(450);
    await screen.rerender(<></>);

    await act(() => panel.openFile(ref, "a.ts"));
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />);
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
  });

  it("types at the first whole line in the editor after the file was read read-only", async () => {
    using reading = await readingSetup("read-only-then-editor-caret");
    const { panel, ref } = reading;
    const path = `${reading.cwd}/a.ts`;
    const file = pathReadingKey(environmentId, path);
    state.files[path] = { ...state.files["a.ts"]!, relativePath: path };
    // Another workspace reads the file read-only, with the viewport top cutting a line.
    const otherRef = scopeThreadRef(environmentId, ThreadId.make("reading-then-editor-caret"));
    using _thread = { [Symbol.dispose]: () => panel.removeThread(otherRef) };
    await act(() => panel.openFile(otherRef, path));
    await using screen = await render(
      <ReadingPanel threadRef={otherRef} cwd="/outside" width={420} />,
    );
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"), COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 1431 } });
    await vi.waitFor(() =>
      expect(readings.readPosition(file, "source")?.offset).toBeGreaterThan(0),
    );
    const shown = view.topLine();
    await screen.rerender(<></>);

    await act(() => panel.openFile(ref, "a.ts"));
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />);
    await vi.waitFor(() => expect(view.topLine()).toEqual(shown), COLD_WORKER);
    const top = view.scroller().scrollTop;
    const focus = screen.container.querySelector<HTMLElement>("[data-file-content-focus]")!;
    await act(() => focus.focus());
    await userEvent.keyboard("Z");
    const typedAt = () =>
      [shown.line, shown.line + 1].find((line) => view.line(line)?.textContent?.startsWith("Z"));
    await vi.waitFor(() => expect(typedAt()).toBeDefined(), COLD_WORKER);
    // The caret goes to the first line that starts in view, and typing does not scroll.
    expect(typedAt()).toBe(shown.line + 1);
    expect(view.scroller().scrollTop).toBe(top);
  });

  it("types in the editor after a read-only place inside a wrapped line that fills the view", async () => {
    using reading = await readingSetup("read-only-tall-then-editor-caret");
    const { panel, ref } = reading;
    const path = `${reading.cwd}/a.ts`;
    const file = pathReadingKey(environmentId, path);
    const rows = sourceFile(path, "alpha", 1500).contents.split("\n");
    rows[449] = `// ${"wrapped words ".repeat(1600)}`;
    const contents = rows.join("\n");
    state.files["a.ts"] = {
      relativePath: "a.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    state.files[path] = { ...state.files["a.ts"]!, relativePath: path };
    // Another workspace reads the file read-only, deep inside a line taller than the view.
    const otherRef = scopeThreadRef(environmentId, ThreadId.make("reading-tall-then-editor-caret"));
    using _thread = { [Symbol.dispose]: () => panel.removeThread(otherRef) };
    await act(() => panel.openFile(otherRef, path, 450));
    await using screen = await render(
      <ReadingPanel threadRef={otherRef} cwd="/outside" width={420} />,
    );
    const view = sourceView(screen.container);
    await vi.waitFor(() => {
      expect(view.line(450)?.getBoundingClientRect().height ?? 0).toBeGreaterThan(4000);
      expect(readings.readPosition(file, "source")?.centered).toBe(true);
    }, COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 3200 } });
    await vi.waitFor(() =>
      expect(readings.readPosition(file, "source")?.offset).toBeGreaterThan(3000),
    );
    const shown = view.topLine();
    await screen.rerender(<></>);

    await act(() => panel.openFile(ref, "a.ts"));
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />);
    await vi.waitFor(() => expect(view.topLine()).toEqual(shown), COLD_WORKER);
    const focus = screen.container.querySelector<HTMLElement>("[data-file-content-focus]")!;
    await act(() => focus.focus());
    await userEvent.keyboard("Z");
    // No line starts in view, so the caret takes the next line, as after the editor's own place.
    await vi.waitFor(
      () => expect(view.line(451)?.textContent?.startsWith("Z")).toBe(true),
      COLD_WORKER,
    );
  });

  it("shows a cited read-only tab's line after the same file's other tab read its dropped place", async () => {
    using reading = await readingSetup("read-only-alias-dropped");
    const { panel, ref } = reading;
    const path = `${reading.cwd}/a.ts`;
    const file = pathReadingKey(environmentId, path);
    state.files[path] = sourceFile(path, "alpha", 300);
    // A citation opens the file by its absolute path; the picker opens it again by its relative one.
    panel.openFile(ref, path, 250);
    const shown = () => <ReadingPanel threadRef={ref} cwd={reading.cwd} />;
    await using screen = await render(shown());
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(250, "alpha_250"), COLD_WORKER);
    await vi.waitFor(() => expect(readings.readPosition(file, "source")?.line).toBe(250));
    await screen.rerender(<></>);
    await act(() => panel.openFile(ref, "a.ts"));
    await screen.rerender(shown());
    await vi.waitFor(() => view.expectLineInView(250, "alpha_250"), COLD_WORKER);
    // Places saved in many other files push this one out of the store.
    for (let index = 0; index < 300; index += 1) {
      readings.writePosition(pathReadingKey(environmentId, `/outside/alias-other-${index}.ts`), {
        view: "source",
        line: 2,
        offset: 0,
      });
    }
    expect(readings.readPosition(file, "source")).toBeNull();

    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(() => view.expectLineInView(250, "alpha_250"), COLD_WORKER);
  });

  it("leaves a read-only file where the reader scrolled it before a new citation's reveal ran", async () => {
    using reading = await readingSetup("read-only-scroll-before-reveal");
    const { panel, ref } = reading;
    const path = "/outside/before-reveal.ts";
    const file = readOnly(path, sourceFile(path, "alpha", 600).contents);
    panel.openFile(ref, path);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"), COLD_WORKER);
    const scroller = view.scroller();
    // An older saved place, then the reader's scroll to 1500 px.
    readings.writePosition(file, { view: "source", line: 75, offset: 12 });
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 1500, bubbles: true }));
    scroller.scrollTop = 1500;
    scroller.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(written(path)).not.toBeNull());
    await vi.waitFor(() => expect(view.line(75)).not.toBeNull());
    const next = 1500 + 313;
    const cited = view.topLine().line + 12;
    // The reader scrolls on once the citation's mark shows, before its scheduled reveal runs.
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const marked = new MutationObserver(() => {
      if (view.line(cited)?.hasAttribute(FILE_LINK_REVEAL_ATTRIBUTE) !== true) return;
      marked.disconnect();
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 313, bubbles: true }));
      scroller.scrollTop = next;
      scroller.dispatchEvent(new Event("scroll"));
    });
    marked.observe(root, { subtree: true, attributeFilter: [FILE_LINK_REVEAL_ATTRIBUTE] });
    using _observer = { [Symbol.dispose]: () => marked.disconnect() };
    const at = JSON.parse(written(path)!).at;
    await act(() => panel.openFile(ref, path, cited));
    // The reader's place stands, also once it is saved.
    await vi.waitFor(() => expect(JSON.parse(written(path)!).at).not.toBe(at), COLD_WORKER);
    expect(scroller.scrollTop).toBe(next);
  });

  it("saves the last line a read-only file showed for a citation past its end, also after it grows", async () => {
    using reading = await readingSetup("read-only-stale-citation");
    const { panel, ref, cwd } = reading;
    const path = "/outside/stale-citation.ts";
    readOnly(path, sourceFile(path, "alpha", 100).contents);
    panel.openFile(ref, path, 250);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(100, "alpha_100"), COLD_WORKER);
    await vi.waitFor(() => expect(written(path)).not.toBeNull());
    expect(JSON.parse(written(path)!).line).toBe(100);

    await screen.rerender(<></>);
    readOnly(path, sourceFile(path, "alpha", 300).contents);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={cwd} />);
    await vi.waitFor(() => expect(offCenter(view, 100)).toBeLessThan(2), COLD_WORKER);
    expect(JSON.parse(written(path)!).line).toBe(100);
  });

  it("returns a landed read-only citation to the place it was centered at", async () => {
    using reading = await readingSetup("read-only-landed-place");
    const { panel, ref } = reading;
    const path = "/outside/landed.ts";
    readOnly(path, sourceFile(path, "alpha", 300).contents);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path, 150);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    /** How far line 150's middle sits from the viewport's middle. */
    const offCenter = () => {
      const line = view.line(150)!.getBoundingClientRect();
      const box = view.scroller().getBoundingClientRect();
      return Math.abs(line.top + line.height / 2 - (box.top + view.scroller().clientHeight / 2));
    };
    await vi.waitFor(() => expect(offCenter()).toBeLessThan(1), COLD_WORKER);
    await vi.waitFor(() => expect(JSON.parse(written(path) ?? "{}").line).toBe(150));

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(() => expect(offCenter()).toBeLessThan(1), COLD_WORKER);
  });

  it("returns a read-only citation reopened with Reopen Closed View to the reader's place", async () => {
    using reading = await readingSetup("read-only-reopen-closed");
    const { panel, ref } = reading;
    readOnly("/outside/a.ts", sourceFile("/outside/a.ts", "alpha", 300).contents);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "/outside/a.ts", 40);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"), COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 2000 } });
    await vi.waitFor(() => expect(view.line(40)).toBeNull());
    const before = view.topLine();

    await act(() => panel.closeSurface(ref, "file:/outside/a.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    const entry = useClosedViewStore
      .getState()
      .entries.find(
        (closed) => closed.kind === "panel-tab" && closed.surface.id === "file:/outside/a.ts",
      )!;
    // Reopen Closed View opens the tab with its old line, then drops the closed entry after an await.
    panel.openFile(ref, "/outside/a.ts", 40);
    await Promise.resolve();
    useClosedViewStore.getState().remove(entry.id);

    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
    expect(view.line(40)).toBeNull();
  });

  it("types at the editor's own place while a read-only pane shows the same file", async () => {
    using reading = await readingSetup("read-only-beside-editor");
    const path = `${reading.cwd}/a.ts`;
    state.files[path] = { ...state.files["a.ts"]!, relativePath: path };
    const otherRef = scopeThreadRef(environmentId, ThreadId.make("reading-read-only-beside"));
    using _thread = { [Symbol.dispose]: () => reading.panel.removeThread(otherRef) };
    reading.panel.openFile(reading.ref, "a.ts");
    const panes = (both: boolean) => (
      <div style={{ display: "flex" }}>
        <div data-editor>
          <ReadingPanel threadRef={reading.ref} cwd={reading.cwd} width={420} />
        </div>
        {both ? (
          <div data-read-only>
            <ReadingPanel threadRef={otherRef} cwd="/outside" width={420} />
          </div>
        ) : null}
      </div>
    );
    await using screen = await render(panes(false));
    const editorPane = screen.container.querySelector<HTMLElement>("[data-editor]")!;
    const editor = sourceView(editorPane);
    await vi.waitFor(() => editor.expectLineInView(1, "alpha_1"), COLD_WORKER);
    await userEvent.wheel(editor.scroller(), { delta: { y: 1431 } });
    const file = pathReadingKey(environmentId, path);
    await vi.waitFor(() => expect(readings.readPosition(file, "source")?.line).toBeGreaterThan(60));
    const caret = readings.readPosition(file, "source")!.line;

    // The same file by its absolute path opens read-only in the other pane, at a cited line.
    reading.panel.openFile(otherRef, path, caret + 5);
    await screen.rerender(panes(true));
    const readOnlyPane = screen.container.querySelector<HTMLElement>("[data-read-only]")!;
    await vi.waitFor(
      () => sourceView(readOnlyPane).expectLineInView(caret + 5, `alpha_${caret + 5}`),
      COLD_WORKER,
    );
    await act(() => editorPane.querySelector<HTMLElement>("[data-file-content-focus]")!.focus());
    await userEvent.keyboard("Z");
    const typedAt = () =>
      [caret, caret + 5].find((line) => editor.line(line)?.textContent?.startsWith("Z"));
    await vi.waitFor(() => expect(typedAt()).toBeDefined(), COLD_WORKER);
    expect(typedAt()).toBe(caret);
  });

  it("leaves an editable file at its top when its shown citation's place was dropped", async () => {
    using reading = await readingSetup("editable-dropped-place");
    const file = pathReadingKey(environmentId, `${reading.cwd}/a.ts`);
    reading.panel.openFile(reading.ref, "a.ts", 150);
    await using screen = await render(
      <ReadingPanel threadRef={reading.ref} cwd={reading.cwd} width={700} />,
    );
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(150, "alpha_150"), COLD_WORKER);
    await vi.waitFor(() => expect(readings.readPosition(file, "source")?.line).toBe(150));
    await screen.rerender(<></>);
    // Places saved in many other files push this one out of the store; the tab keeps its citation.
    for (let index = 0; index < 300; index += 1) {
      readings.writePosition(pathReadingKey(environmentId, `${reading.cwd}/other-${index}.ts`), {
        view: "source",
        line: 2,
        offset: 0,
      });
    }
    expect(readings.readPosition(file, "source")).toBeNull();

    await screen.rerender(<ReadingPanel threadRef={reading.ref} cwd={reading.cwd} width={700} />);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"), COLD_WORKER);
    // The reader's next scroll starts from the top, not from the citation.
    await userEvent.wheel(view.scroller(), { delta: { y: 100 } });
    await vi.waitFor(() => expect(readings.readPosition(file, "source")).not.toBeNull());
    expect(readings.readPosition(file, "source")!.line).toBeLessThan(20);
  });

  it("returns a read-only reader to a place deep inside a long wrapped line", async () => {
    using reading = await readingSetup("read-only-deep-line");
    const { panel, ref } = reading;
    const path = "/outside/deep-line.ts";
    const contents = sourceFile(path, "alpha", 1500).contents.split("\n");
    contents[449] = `// ${"wrapped words ".repeat(4000)}`;
    const file = readOnly(path, contents.join("\n"));
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path, 450);
    await using screen = await render(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />,
    );
    const view = sourceView(screen.container);
    await vi.waitFor(() => {
      expect(view.line(450)?.getBoundingClientRect().height ?? 0).toBeGreaterThan(14_000);
      expect(readings.readPosition(file, "source")?.line).toBe(450);
    }, COLD_WORKER);
    // The reader scrolls far into the cited line, past what a new view estimates for it.
    await userEvent.wheel(view.scroller(), { delta: { y: 10_000 } });
    await vi.waitFor(() =>
      expect(readings.readPosition(file, "source")?.offset).toBeGreaterThan(8000),
    );
    const before = view.topLine();
    expect(before.line).toBe(450);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before), COLD_WORKER);
  });

  it("returns a read-only file that starts with a line taller than the view to its top", async () => {
    using reading = await readingSetup("read-only-tall-first-line");
    const { panel, ref } = reading;
    const path = "/outside/tall-first-line.ts";
    readOnly(path, `// ${"wrapped words ".repeat(500)}\n${sourceFile(path, "tail", 100).contents}`);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path);
    await using screen = await render(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} width={420} />,
    );
    const view = sourceView(screen.container);
    const firstLineFills = () =>
      expect(view.line(1)?.getBoundingClientRect().height ?? 0).toBeGreaterThan(
        view.scroller().clientHeight,
      );
    await vi.waitFor(firstLineFills, COLD_WORKER);
    // The reader scrolls down and back to the very top, above the first row's top padding.
    await userEvent.wheel(view.scroller(), { delta: { y: 600 } });
    await vi.waitFor(() => expect(view.scroller().scrollTop).toBe(600));
    await userEvent.wheel(view.scroller(), { delta: { y: -1200 } });
    await vi.waitFor(() => expect(JSON.parse(written(path) ?? "{}").offset).toBeLessThan(0));

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    // The restored view must not move off the top, also once its first line is measured.
    let moved = false;
    const watch = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.scrollTop !== 0) moved = true;
    };
    document.addEventListener("scroll", watch, true);
    using _watch = { [Symbol.dispose]: () => document.removeEventListener("scroll", watch, true) };
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(firstLineFills, COLD_WORKER);
    // The reader's wheel up at the top ends the restore.
    await userEvent.wheel(view.scroller(), { delta: { y: -100 } });
    expect(moved).toBe(false);
    expect(view.scroller().scrollTop).toBe(0);
  });

  it("shows a cited read-only Markdown file's source again, not an older rendered place", async () => {
    using reading = await readingSetup("read-only-markdown-citation");
    const { panel, ref } = reading;
    const path = "/outside/notes.md";
    const file = readOnly(
      path,
      Array.from({ length: 300 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n"),
    );
    readings.writePosition(file, { view: "rendered", block: 20, fraction: 0 });
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path, 201);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(201, "Paragraph 101."), COLD_WORKER);
    await vi.waitFor(() =>
      expect(readings.newestView(file, ["source", "rendered", "offset"])).toBe("source"),
    );

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await screen.rerender(<></>);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(() => view.expectLineInView(201, "Paragraph 101."), COLD_WORKER);
    expect(screen.container.querySelector(".chat-markdown")).toBeNull();
  });

  it("shows a cited read-only CSV file's source again, not an older table row", async () => {
    using reading = await readingSetup("read-only-csv-citation");
    const { panel, ref } = reading;
    const path = "/outside/table.csv";
    const file = readOnly(path, csv(300));
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, path);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const rows = rowsView(screen.container);
    const view = sourceView(screen.container);
    await vi.waitFor(rows.indexed, COLD_WORKER);
    await rows.wheel(2900);
    await vi.waitFor(() =>
      expect(readings.readPosition(file, "rendered")?.block).toBeGreaterThan(50),
    );

    await act(() => panel.openFile(ref, path, 40));
    await vi.waitFor(() => view.expectLineInView(40, "row 39,38"), COLD_WORKER);
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, `file:${path}`));
    await vi.waitFor(() => view.expectLineInView(40, "row 39,38"), COLD_WORKER);
    expect(rows.scroller()).toBeNull();
  });
});

describe("large text and table rows keep the reader's place", () => {
  it("returns a CSV table to the reader's row after a tab switch, capped at the end when shorter", async () => {
    using reading = await readingSetup("csv");
    const { panel, ref } = reading;
    const table = (rows: number) => {
      const contents = csv(rows);
      return { relativePath: "table.csv", contents, byteLength: contents.length, truncated: false };
    };
    state.files["table.csv"] = table(300);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "table.csv");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const rows = rowsView(screen.container);
    const view = sourceView(screen.container);
    await vi.waitFor(rows.indexed, COLD_WORKER);
    await rows.wheel(2900);
    await vi.waitFor(() =>
      expect(reading.saved("table.csv", "rendered")?.block).toBeGreaterThan(50),
    );
    const before = rows.topRow();
    expect(before).toBe(reading.saved("table.csv", "rendered")?.block);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:table.csv"));
    await vi.waitFor(() => expect(rows.topRow()).toBe(before), COLD_WORKER);

    await screen.rerender(<></>);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    await vi.waitFor(() => expect(rows.topRow()).toBe(before), COLD_WORKER);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    const saved = reading.saved("table.csv", "rendered");
    state.files["table.csv"] = table(40);
    await act(() => panel.activateSurface(ref, "file:table.csv"));
    await vi.waitFor(() => {
      rows.indexed();
      const scroller = rows.scroller()!;
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
      expect(scroller.scrollTop).toBeGreaterThanOrEqual(
        scroller.scrollHeight - scroller.clientHeight - 1,
      );
    }, COLD_WORKER);
    expect(reading.saved("table.csv", "rendered")).toEqual(saved);
  });

  it("keeps a CSV table's saved row when the page hides before its rows follow a scroll to the top", async () => {
    using reading = await readingSetup("csv-page-hide");
    const { panel, ref } = reading;
    const path = "page-hide.csv";
    const contents = csv(1500);
    state.files[path] = {
      relativePath: path,
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    panel.openFile(ref, path);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const rows = rowsView(screen.container);
    await vi.waitFor(rows.indexed, COLD_WORKER);
    await rows.wheel(8900);
    await vi.waitFor(() => expect(reading.saved(path, "rendered")?.block).toBeGreaterThan(150));
    const before = reading.saved(path, "rendered")!.block;
    const scroller = rows.scroller()!;
    const hidden = Promise.withResolvers<number | undefined>();
    scroller.addEventListener("scroll", () => {
      if (scroller.scrollTop !== 0) return;
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
      hidden.resolve(reading.saved(path, "rendered")?.block);
    });
    await rows.wheel(-10_000);
    expect(await hidden.promise).toBe(before);
  });

  it("keeps a text file's line when it grows past the full-text read and when it shrinks back", async () => {
    using reading = await readingSetup("crossing");
    const { panel, ref } = reading;
    const contents = lines(400);
    const small = {
      relativePath: "app.log",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    state.files["app.log"] = small;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "app.log");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    const rows = rowsView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "log line 1"));
    await userEvent.wheel(view.scroller(), { delta: { y: 2000 } });
    await vi.waitFor(() => expect(reading.saved("app.log", "source")?.line).toBeGreaterThan(50));
    const read = reading.saved("app.log", "source")!.line!;

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    reading.serve("app.log", contents);
    state.files["app.log"] = { ...small, byteLength: LARGE_TEXT_BYTES, truncated: true };
    await act(() => panel.activateSurface(ref, "file:app.log"));
    await vi.waitFor(() => {
      rows.indexed();
      expect(rows.topRow()).toBe(read - 1);
    }, COLD_WORKER);

    await rows.wheel(2000);
    await vi.waitFor(() =>
      expect(reading.saved("app.log", "source")?.line).toBeGreaterThan(read + 30),
    );
    const later = reading.saved("app.log", "source")!.line!;
    expect(rows.topRow()).toBe(later - 1);
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    state.files["app.log"] = small;
    await act(() => panel.activateSurface(ref, "file:app.log"));
    await vi.waitFor(() => expect(view.topLine()).toEqual({ line: later, offset: 0 }));
  });

  it("reveals a cited line of a large text file once, even when the reader scrolls and leaves while it indexes, then returns to the reader's place", async () => {
    using reading = await readingSetup("large-cited");
    using indexing = holdIndexing();
    const { panel, ref } = reading;
    largeText(reading, "big.log", lines(600));
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "big.log", 40);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const rows = rowsView(screen.container);
    const view = sourceView(screen.container);
    await vi.waitFor(() => expect(rows.topRow()).toBe(0), COLD_WORKER);
    await rows.wheel(600);
    await vi.waitFor(() => expect(reading.saved("big.log", "source")?.line).toBeGreaterThan(10));
    // The reader leaves before indexing ends, so the viewer has yet to show the citation.
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:big.log"));
    await vi.waitFor(() => expect(rows.topRow()).toBe(0), COLD_WORKER);
    indexing.release();
    await vi.waitFor(
      () =>
        expect(
          screen.container.querySelector('[data-preview-reveal="true"]')?.textContent,
        ).toContain("log line 40"),
      COLD_WORKER,
    );
    expect(reading.saved("big.log", "source")?.line).toBe(40);

    await rows.wheel(3000);
    await vi.waitFor(() => expect(reading.saved("big.log", "source")?.line).toBeGreaterThan(100));
    const before = rows.topRow();
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:big.log"));
    await vi.waitFor(() => {
      rows.indexed();
      expect(rows.topRow()).toBe(before);
    }, COLD_WORKER);
  });

  it("leaves a large text file where the reader scrolled it while it indexed, and a click there keeps the restore", async () => {
    using reading = await readingSetup("indexing");
    using indexing = holdIndexing();
    const { panel, ref } = reading;
    largeText(reading, "big.log", `${lines(600)}\n`);
    readings.writePosition(
      { kind: "path", environmentId, absolutePath: `${reading.cwd}/big.log` },
      { view: "source", line: 40, offset: 0 },
    );
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "big.log");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const rows = rowsView(screen.container);
    const view = sourceView(screen.container);
    // The worker has read all 600 rows; the status shows counts only once indexing ends.
    const stillIndexing = () => {
      expect(screen.container.querySelector("[aria-rowcount]")?.getAttribute("aria-rowcount")).toBe(
        "600",
      );
      expect(screen.container.querySelector('[role="status"]')?.textContent).toBe("");
    };
    await vi.waitFor(stillIndexing, COLD_WORKER);
    await rows.wheel(3000);
    await vi.waitFor(() => expect(rows.topRow()).toBeGreaterThan(80));
    const top = rows.scroller()!.scrollTop;

    indexing.release();
    await vi.waitFor(rows.indexed);
    expect(Math.abs(rows.scroller()!.scrollTop - top)).toBeLessThan(29);
    await vi.waitFor(() => expect(reading.saved("big.log", "source")?.line).toBeGreaterThan(80));
    const line = reading.saved("big.log", "source")!.line!;
    // Opening the file again from the tree keeps the rows where the reader has them.
    await act(() => panel.openFile(ref, "big.log"));
    expect(screen.container.querySelector('[data-preview-reveal="true"]')).toBeNull();
    expect(Math.abs(rows.scroller()!.scrollTop - top)).toBeLessThan(29);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    indexing.hold();
    await act(() => panel.activateSurface(ref, "file:big.log"));
    // A click that scrolls nothing while it indexes leaves the restore to land.
    await vi.waitFor(stillIndexing, COLD_WORKER);
    await userEvent.click(rows.scroller()!);
    indexing.release();
    await vi.waitFor(() => {
      rows.indexed();
      expect(rows.topRow()).toBe(line - 1);
    }, COLD_WORKER);
  });

  it("returns a large text file to a saved line that arrives after the first second of its download", async () => {
    using reading = await readingSetup("large-fed-place");
    const { panel, ref } = reading;
    const contents = lines(1200);
    const upTo = (line: number) => contents.slice(0, contents.indexOf(`log line ${line + 1}\n`));
    using download = feedLargeText(reading, "fed.log", upTo(100), contents.length);
    readings.writePosition(pathReadingKey(environmentId, `${reading.cwd}/fed.log`), {
      view: "source",
      line: 900,
      offset: 0,
    });
    panel.openFile(ref, "fed.log");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(100, "log line 100"), COLD_WORKER);
    // Each piece shows in its own swap, so the last one arrives a second or more after the first.
    const preview = view.scroller().scrollHeight;
    download.send(upTo(500).slice(upTo(100).length));
    await vi.waitFor(
      () => expect(view.scroller().scrollHeight).toBeGreaterThan(preview + GROWN_PX),
      COLD_WORKER,
    );
    download.send(`${contents.slice(upTo(500).length)}\n`);

    await vi.waitFor(() => expect(view.topLine()).toEqual({ line: 900, offset: 0 }), COLD_WORKER);
  });

  it("centers a large text file's cited line that arrives after the first second of its download, and saves it", async () => {
    using reading = await readingSetup("large-fed-cited");
    const { panel, ref } = reading;
    const contents = lines(1200);
    const upTo = (line: number) => contents.slice(0, contents.indexOf(`log line ${line + 1}\n`));
    using download = feedLargeText(reading, "fed-cited.log", upTo(100), contents.length);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "fed-cited.log", 900);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(100, "log line 100"), COLD_WORKER);
    const preview = view.scroller().scrollHeight;
    download.send(upTo(500).slice(upTo(100).length));
    await vi.waitFor(
      () => expect(view.scroller().scrollHeight).toBeGreaterThan(preview + GROWN_PX),
      COLD_WORKER,
    );
    download.send(`${contents.slice(upTo(500).length)}\n`);

    await vi.waitFor(() => expect(offCenter(view, 900)).toBeLessThan(2), COLD_WORKER);
    expect(reading.saved("fed-cited.log", "source")?.line).toBe(900);
  });

  it("centers a large text file's cited line when the download finishes while the reveal scrolls", async () => {
    using reading = await readingSetup("large-fed-mid-reveal");
    const { panel, ref } = reading;
    const contents = lines(1200);
    const upTo = (line: number) => contents.slice(0, contents.indexOf(`log line ${line + 1}\n`));
    using download = feedLargeText(reading, "fed-race.log", upTo(100), contents.length);
    panel.openFile(ref, "fed-race.log");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "log line 1"), COLD_WORKER);
    // The rest of the file arrives as the reveal starts its scroll to the last line shown.
    const scrollToLine = VirtualizedFile.prototype.scrollToLine;
    const reveal = vi
      .spyOn(VirtualizedFile.prototype, "scrollToLine")
      .mockImplementationOnce(function (this: VirtualizedFile<unknown, undefined>, ...args) {
        download.send(contents.slice(upTo(100).length));
        download.end();
        return scrollToLine.apply(this, args);
      });
    using _reveal = { [Symbol.dispose]: () => reveal.mockRestore() };
    await act(() => panel.openFile(ref, "fed-race.log", 900));

    await vi.waitFor(() => expect(offCenter(view, 900)).toBeLessThan(2), COLD_WORKER);
    expect(reveal.mock.calls[0]?.[0]).toBeLessThan(900);
    expect(reading.saved("fed-race.log", "source")?.line).toBe(900);
  });

  it("centers a large text file's new citation after the reader scrolled its first piece", async () => {
    using reading = await readingSetup("large-fed-cite-after-scroll");
    const { panel, ref } = reading;
    const contents = lines(1200);
    const upTo = (line: number) => contents.slice(0, contents.indexOf(`log line ${line + 1}\n`));
    using download = feedLargeText(reading, "fed-later.log", upTo(100), contents.length);
    panel.openFile(ref, "fed-later.log");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "log line 1"), COLD_WORKER);
    await userEvent.wheel(view.scroller(), { delta: { y: 780 } });
    await vi.waitFor(() =>
      expect(reading.saved("fed-later.log", "source")?.line).toBeGreaterThan(1),
    );
    await act(() => panel.openFile(ref, "fed-later.log", 900));
    await vi.waitFor(() =>
      expect(reading.saved("fed-later.log", "source")?.line).toBeGreaterThanOrEqual(100),
    );
    download.send(`${contents.slice(upTo(100).length)}\n`);

    await vi.waitFor(() => expect(offCenter(view, 900)).toBeLessThan(2), COLD_WORKER);
    expect(reading.saved("fed-later.log", "source")?.line).toBe(900);
  });

  it("leaves a large text file where the reader scrolled it after a citation past its first piece", async () => {
    using reading = await readingSetup("large-fed-reader-wins");
    const { panel, ref } = reading;
    const contents = lines(1200);
    const upTo = (line: number) => contents.slice(0, contents.indexOf(`log line ${line + 1}\n`));
    using download = feedLargeText(reading, "fed-reader.log", upTo(100), contents.length);
    panel.openFile(ref, "fed-reader.log", 900);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(100, "log line 100"), COLD_WORKER);
    await vi.waitFor(() =>
      expect(reading.saved("fed-reader.log", "source")?.line).toBeGreaterThanOrEqual(100),
    );
    await userEvent.wheel(view.scroller(), { delta: { y: -780 } });
    await vi.waitFor(() =>
      expect(reading.saved("fed-reader.log", "source")?.line).toBeLessThan(100),
    );
    const before = view.topLine();
    const height = view.scroller().scrollHeight;
    download.send(`${contents.slice(upTo(100).length)}\n`);
    await vi.waitFor(
      () => expect(view.scroller().scrollHeight).toBeGreaterThan(height + GROWN_PX),
      COLD_WORKER,
    );

    expect(view.topLine()).toEqual(before);
  });

  it("centers a large text file's cited line that arrives after a tab switch and a remount", async () => {
    using reading = await readingSetup("large-fed-cited-away");
    const { panel, ref } = reading;
    const contents = lines(1200);
    const upTo = (line: number) => contents.slice(0, contents.indexOf(`log line ${line + 1}\n`));
    using download = feedLargeText(reading, "fed-away.log", upTo(100), contents.length);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "fed-away.log", 900);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(100, "log line 100"), COLD_WORKER);
    await vi.waitFor(() => expect(reading.saved("fed-away.log", "source")).not.toBeNull());
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:fed-away.log"));
    await vi.waitFor(() => view.expectLineInView(100, "log line 100"), COLD_WORKER);
    await screen.rerender(<></>);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    await vi.waitFor(() => view.expectLineInView(100, "log line 100"), COLD_WORKER);
    download.send(`${contents.slice(upTo(100).length)}\n`);

    await vi.waitFor(() => expect(offCenter(view, 900)).toBeLessThan(2), COLD_WORKER);
    expect(reading.saved("fed-away.log", "source")?.line).toBe(900);
  });

  it("keeps a large text file where the reader dragged it while a piece of the download arrived", async () => {
    using reading = await readingSetup("large-fed-drag");
    const { panel, ref } = reading;
    const contents = lines(1200);
    const upTo = (line: number) => contents.slice(0, contents.indexOf(`log line ${line + 1}\n`));
    using download = feedLargeText(reading, "fed-drag.log", upTo(100), contents.length);
    readings.writePosition(pathReadingKey(environmentId, `${reading.cwd}/fed-drag.log`), {
      view: "source",
      line: 50,
      offset: 0,
    });
    panel.openFile(ref, "fed-drag.log");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => expect(view.topLine()).toEqual({ line: 50, offset: 0 }), COLD_WORKER);
    const scroller = view.scroller();
    // The reader presses on a line to select text, a piece arrives, and the drag scrolls the view.
    view
      .line(55)!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    const height = scroller.scrollHeight;
    download.send(upTo(500).slice(upTo(100).length));
    await vi.waitFor(
      () => expect(scroller.scrollHeight).toBeGreaterThan(height + GROWN_PX),
      COLD_WORKER,
    );
    scroller.scrollTop += 1800;
    scroller.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new PointerEvent("pointerup"));
    await vi.waitFor(() =>
      expect(reading.saved("fed-drag.log", "source")?.line).toBeGreaterThan(100),
    );
    const released = view.topLine();
    const grown = scroller.scrollHeight;
    download.send(`${contents.slice(upTo(500).length)}\n`);
    await vi.waitFor(
      () => expect(scroller.scrollHeight).toBeGreaterThan(grown + GROWN_PX),
      COLD_WORKER,
    );

    expect(view.topLine()).toEqual(released);
  });

  it("centers a large text file's cited line whose last piece arrived during a click, on release", async () => {
    using reading = await readingSetup("large-fed-click");
    const { panel, ref } = reading;
    const contents = lines(1200);
    const upTo = (line: number) => contents.slice(0, contents.indexOf(`log line ${line + 1}\n`));
    using download = feedLargeText(reading, "fed-click.log", upTo(100), contents.length);
    panel.openFile(ref, "fed-click.log", 900);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(100, "log line 100"), COLD_WORKER);
    await vi.waitFor(() => expect(reading.saved("fed-click.log", "source")?.line).toBe(900));
    const scroller = view.scroller();
    view
      .line(95)!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    const height = scroller.scrollHeight;
    download.send(contents.slice(upTo(100).length));
    download.end();
    await vi.waitFor(
      () => expect(scroller.scrollHeight).toBeGreaterThan(height + GROWN_PX),
      COLD_WORKER,
    );
    window.dispatchEvent(new PointerEvent("pointerup"));

    await vi.waitFor(() => expect(offCenter(view, 900)).toBeLessThan(2), COLD_WORKER);
  });

  it("saves the last line of a downloaded large text file for a citation past its end", async () => {
    using reading = await readingSetup("large-fed-past-end");
    const { panel, ref } = reading;
    const contents = lines(1200);
    const upTo = (line: number) => contents.slice(0, contents.indexOf(`log line ${line + 1}\n`));
    using download = feedLargeText(reading, "fed-end.log", upTo(100), contents.length);
    panel.openFile(ref, "fed-end.log");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "log line 1"), COLD_WORKER);
    const height = view.scroller().scrollHeight;
    download.send(contents.slice(upTo(100).length));
    download.end();
    await vi.waitFor(
      () => expect(view.scroller().scrollHeight).toBeGreaterThan(height + GROWN_PX),
      COLD_WORKER,
    );
    await act(() => panel.openFile(ref, "fed-end.log", 2000));

    await vi.waitFor(() => view.expectLineInView(1200, "log line 1200"), COLD_WORKER);
    await vi.waitFor(() => expect(reading.saved("fed-end.log", "source")?.line).toBe(1200));
  });

  it("returns a large text file that changed while open to the reader's line", async () => {
    using reading = await readingSetup("changed");
    const { panel, ref } = reading;
    largeText(reading, "app.log", `${lines(600)}\n`);
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "app.log");
    await using screen = await render(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} workspaceMutationId="before" />,
    );
    const rows = rowsView(screen.container);
    await vi.waitFor(rows.indexed, COLD_WORKER);
    await rows.wheel(3000);
    await vi.waitFor(() => expect(reading.saved("app.log", "source")?.line).toBeGreaterThan(50));
    const line = reading.saved("app.log", "source")!.line!;

    // An agent appends to the log, and the viewer loads the new bytes.
    largeText(reading, "app.log", `${lines(700)}\n`);
    await screen.rerender(
      <ReadingPanel threadRef={ref} cwd={reading.cwd} workspaceMutationId="after" />,
    );
    await vi.waitFor(() => {
      rows.indexed();
      expect(screen.container.querySelector('[role="status"]')?.textContent).toContain("700 lines");
      expect(rows.topRow()).toBe(line - 1);
    }, COLD_WORKER);
  });

  it("returns a large CSV attachment's table and its raw text each to its own line", async () => {
    using reading = await readingSetup("csv-attachment");
    const data: ChatFileAttachment = {
      type: "file",
      id: "attachment-data.csv" as ChatFileAttachment["id"],
      name: "data.csv",
      mimeType: "text/csv",
      sizeBytes: 2_000_000,
    };
    reading.attach(data, csv(400));
    const key = { kind: "attachment", environmentId, attachmentId: data.id } as const;
    readings.writePosition(key, { view: "rendered", block: 80, fraction: 0 });
    readings.writePosition(key, { view: "source", line: 200, offset: 0 });
    await using screen = await render(
      <AttachmentPanel threadRef={reading.ref} cwd={reading.cwd} attachment={data} />,
    );
    const rows = rowsView(screen.container);
    await vi.waitFor(() => {
      rows.indexed();
      expect(rows.topRow()).toBe(80);
    }, COLD_WORKER);

    await userEvent.click(screen.getByRole("button", { name: "Show source" }));
    await vi.waitFor(() => {
      rows.indexed();
      expect(screen.container.querySelector('[role="region"][aria-rowcount]')).not.toBeNull();
      expect(rows.topRow()).toBe(199);
    }, COLD_WORKER);
  });

  it("scrolls a CSV attachment's table on past its saved row", async () => {
    using reading = await readingSetup("small-csv-attachment");
    const text = csv(400);
    const data: ChatFileAttachment = {
      type: "file",
      id: "attachment-table.csv" as ChatFileAttachment["id"],
      name: "table.csv",
      mimeType: "text/csv",
      sizeBytes: text.length,
    };
    reading.attach(data, text);
    const key = { kind: "attachment", environmentId, attachmentId: data.id } as const;
    readings.writePosition(key, { view: "rendered", block: 80, fraction: 0 });
    await using screen = await render(
      <AttachmentPanel threadRef={reading.ref} cwd={reading.cwd} attachment={data} />,
    );
    const rows = rowsView(screen.container);
    await vi.waitFor(() => {
      rows.indexed();
      expect(rows.topRow()).toBe(80);
    }, COLD_WORKER);
    // The scroll re-renders the panel, which must not load the attachment and its table again.
    const table = rows.scroller();
    await rows.wheel(1500);
    await vi.waitFor(() =>
      expect(reading.attachmentSaved(data.id, "rendered")?.block).toBeGreaterThan(110),
    );
    expect(rows.scroller()).toBe(table);
    expect(rows.topRow()).toBe(reading.attachmentSaved(data.id, "rendered")?.block);
  });
});
