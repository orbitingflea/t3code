import {
  CodeView,
  VirtualizedFile,
  type File as FileInstance,
  type PostRenderPhase,
} from "@pierre/diffs";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { useState } from "react";

import { isBrowserPreviewFile } from "~/browser/openFileInPreview";
import { useClosedViewStore } from "~/closedViewStore";
import { useRightPanelStore } from "~/rightPanelStore";

import {
  createRevealLedger,
  fileReadingId,
  liveFileSurface,
  type FileReadingKey,
  type ReadingPositionOf,
  type ReadingView,
  type RevealVerdict,
} from "./fileReadingStore";

import {
  type Binding,
  ReadingTracker,
  type ScrollTarget,
  useViewerPlace,
} from "./fileReadingPlace";
import { readings } from "./fileReadingSave";

const ledger = createRevealLedger(readings, useRightPanelStore, useClosedViewStore);

export const pathReadingKey = (environmentId: string, absolutePath: string): FileReadingKey => ({
  kind: "path",
  environmentId,
  absolutePath,
});
ledger.start();

const NO_VIEWS: ReadonlyArray<ReadingView> = [];
/** The editor reveals a citation at once, before the reader can scroll it. */
const ignoreScroll = () => {};
// A workspace file's code view has its own tracker; an attachment's source view is the container's.
const PATH_VIEWS: ReadonlyArray<ReadingView> = ["rendered", "offset"];
const ATTACHMENT_VIEWS: ReadonlyArray<ReadingView> = ["rendered", "offset", "source"];

type FilePostRender = <LAnnotation>(
  fileContainer: HTMLElement,
  instance: FileInstance<LAnnotation, undefined>,
  phase: PostRenderPhase,
) => void;
/** The editor's virtualizer or the read-only CodeView. */
type SourceScroller = "virtualizer" | "codeView";
type SourcePosition = ReadingPositionOf<"source">;

type SourceLines = Pick<
  VirtualizedFile<unknown, undefined>,
  "getLinePosition" | "getNumericScrollAnchor" | "file"
>;

const encoder = new TextEncoder();

/**
 * How far into its line a place starts, kept inside the line's height as it stands now, so a line
 * not yet measured is drawn and measured before a later frame places the rest.
 */
const withinLine = (offset: number, line: { readonly height: number }) =>
  Math.min(offset, Math.max(0, line.height - 1));

/** The editor's place: its file element spans the whole file. */
class SourceGeometry {
  readonly binding: Binding<SourcePosition>;

  constructor(
    protected readonly element: HTMLElement,
    protected fileContainer: HTMLElement,
    protected lines: SourceLines,
  ) {
    this.binding = { element, geometry: this };
  }

  follow(fileContainer: HTMLElement, lines: SourceLines): void {
    this.fileContainer = fileContainer;
    this.lines = lines;
  }

  target(position: SourcePosition): ScrollTarget | null {
    const line = this.lines.getLinePosition(position.line);
    return line === undefined
      ? null
      : { top: this.fileTop() + line.top + withinLine(position.offset, line) };
  }

  capture(): SourcePosition | null {
    const viewportTop = this.element.scrollTop - this.fileTop();
    const anchor = this.lines.getNumericScrollAnchor(viewportTop);
    if (anchor === undefined) return null;
    return { view: "source", line: anchor.lineNumber, offset: viewportTop - anchor.top };
  }

  /** Where a line reveal centers `line`. */
  centered(line: number): SourcePosition {
    const height = this.lines.getLinePosition(line)?.height ?? 0;
    return { view: "source", line, offset: -Math.max(0, (this.element.clientHeight - height) / 2) };
  }

  private fileTop(): number {
    return (
      this.element.scrollTop +
      this.fileContainer.getBoundingClientRect().top -
      this.element.getBoundingClientRect().top
    );
  }
}

/**
 * CodeView's place. Its file element holds only the mounted rows, so the place is read in CodeView's
 * own coordinates, and CodeView scrolls to it, measuring the rows it mounts on the way.
 */
class CodeViewGeometry extends SourceGeometry {
  private counted: { readonly contents: string; readonly lines: number } | null = null;
  private shift = 0;

  /**
   * Where the scroller shows `position`, from the line model as it stands now: the tracker places it
   * every frame, so rows CodeView measures on the way, and its own scroll anchoring, do not move the
   * reader off it.
   */
  override target(position: SourcePosition): ScrollTarget | null {
    const view = this.view();
    const line = this.lines.getLinePosition(position.line);
    if (view === null || line === undefined) return null;
    // A landed citation is centered at the line's height as it stands now.
    const offset =
      position.centered === true
        ? -Math.max(0, this.element.clientHeight - line.height) / 2
        : withinLine(position.offset, line);
    const logical = view.top + line.top + view.shift + offset;
    // CodeView pages the scroller of a very long file, so its own scroll top can run ahead of it.
    return { top: logical - (view.viewer.getScrollTop() - this.element.scrollTop) };
  }

  /**
   * The line the viewport top cuts, and how far below that line's top the viewport starts. Pierre's
   * line model places every line, mounted or not, as CodeView's own scroll does, so a window of rows
   * not yet moved to the new offset does not matter.
   */
  override capture(): SourcePosition | null {
    const view = this.view();
    const contents = this.lines.file?.contents;
    if (view === null || contents === undefined) return null;
    // In the line model's terms, the drawn rows' top padding moved out.
    const viewportTop = view.viewer.getScrollTop() - view.top - view.shift;
    const top = (line: number) => this.lines.getLinePosition(line)?.top ?? Number.NaN;
    // Pierre places a line past the end where the last line is, so a real line starts below the one before.
    const startsAtOrAbove = (line: number) =>
      top(line) <= viewportTop && (line === 1 || top(line - 1) < top(line));
    // The last line that starts at or above the viewport top.
    let low = 1;
    let high = this.lineCount();
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (startsAtOrAbove(middle)) low = middle;
      else high = middle - 1;
    }
    const lineTop = top(low);
    return Number.isNaN(lineTop)
      ? null
      : { view: "source", line: low, offset: viewportTop - lineTop };
  }

  /**
   * Whether the text shown is less than the file's `bytes`, as while it downloads. The read drops a
   * leading byte order mark, 3 bytes.
   */
  partial(bytes: number | null): boolean {
    const contents = this.lines.file?.contents;
    return bytes !== null && contents !== undefined && encoder.encode(contents).length < bytes - 3;
  }

  /** The lines of the text shown, as the panel's reveal counts them, counted once per text. */
  lineCount(): number {
    const contents = this.lines.file?.contents ?? "";
    if (this.counted?.contents !== contents) {
      let lines = 1;
      for (let index = 0; index < contents.length; index += 1) {
        const character = contents.charCodeAt(index);
        if (character === 13 && contents.charCodeAt(index + 1) === 10) index += 1;
        if (character === 10 || character === 13) lines += 1;
      }
      this.counted = { contents, lines };
    }
    return this.counted.lines;
  }

  /** The CodeView that shows this file, which Pierre keeps in a field its types mark private. */
  private view() {
    const viewer: unknown = Reflect.get(this.lines, "virtualizer");
    if (!(viewer instanceof CodeView) || !this.fileContainer.isConnected) return null;
    const id = viewer.getRenderedItems().find((item) => item.instance === this.lines)?.id;
    const top = id === undefined ? undefined : viewer.getTopForItem(id);
    if (id === undefined || top === undefined) return null;
    return { viewer, id, top, shift: this.measureShift() };
  }

  /**
   * How far below the line model CodeView draws its rows (the code element's top padding), so a place
   * is where the reader saw them, as in the editor. The file element starts at its first row's model
   * top and moves with it, also in a window CodeView has yet to move.
   */
  private measureShift(): number {
    const row = (this.fileContainer.shadowRoot ?? this.fileContainer).querySelector("[data-line]");
    if (row === null) return this.shift;
    this.shift = row.getBoundingClientRect().top - this.fileContainer.getBoundingClientRect().top;
    return this.shift;
  }
}

interface SourceBinding {
  readonly tracker: ReadingTracker;
  readonly geometry: SourceGeometry;
  /** Told when the reader scrolls the view, with the panel's latest render. */
  readerScrolled: () => void;
  /** The reader scrolled this code view, so it already shows the reader's place. */
  readerMoved: boolean;
  /** The text the code view shows, which grows while a large file downloads. */
  contents: string | undefined;
  /** The text grew while the reader held the pointer down, so the place waits for the release. */
  grewWhilePressed: boolean;
  /** A large file's size in bytes while the panel shows its text as it downloads, else null. */
  downloadBytes: number | null;
  readonly dispose: () => void;
}
// Keyed by Pierre's file container: its unmount phase also fires when the file turns into a placeholder.
const sourceBindings = new WeakMap<HTMLElement, SourceBinding>();
/**
 * The tab paths whose source place a panel has read or saved. When the store later drops that place,
 * the panel's own pixel memory, kept by the same path, restores the view, not a citation's fallback.
 */
interface PanelPlaces {
  readonly paths: Set<string>;
  readonly path: string;
}
/** The editor's tracker by file, whose place sets the editor's caret line. */
const sourceTrackerByFile = new Map<string, ReadingTracker>();

function trackSourceView(
  fileContainer: HTMLElement,
  instance: SourceLines,
  phase: PostRenderPhase,
  file: FileReadingKey,
  verdict: RevealVerdict,
  scroller: SourceScroller,
  readerScrolled: () => void,
  citedLine: number | null,
  placed: PanelPlaces,
  downloadBytes: number | null,
): void {
  const existing = sourceBindings.get(fileContainer);
  if (phase === "unmount") {
    existing?.dispose();
    sourceBindings.delete(fileContainer);
    if (
      existing !== undefined &&
      sourceTrackerByFile.get(fileReadingId(file)) === existing.tracker
    ) {
      sourceTrackerByFile.delete(fileReadingId(file));
    }
    return;
  }
  if (existing !== undefined) {
    existing.readerScrolled = readerScrolled;
    existing.downloadBytes = downloadBytes;
    existing.geometry.follow(fileContainer, instance);
    const contents = instance.file?.contents;
    const grew = existing.contents !== contents;
    existing.contents = contents;
    if (verdict === "pending") existing.tracker.stop();
    // A place past the text shown so far is placed again as more of the file arrives. A pointer
    // held down may drag the view, so the place waits for its release.
    else if (grew && scroller === "codeView" && !existing.readerMoved) {
      if (existing.tracker.pressed) existing.grewWhilePressed = true;
      else placeAgain(existing);
    }
    return;
  }
  const element = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
  if (element === null) return;
  const geometry = new (scroller === "codeView" ? CodeViewGeometry : SourceGeometry)(
    element,
    fileContainer,
    instance,
  );
  const codeView = scroller === "codeView";
  const tracker = new ReadingTracker(element, file, (scrolled) => {
    if (scrolled !== element) return null;
    if (codeView) binding.readerMoved = true;
    placed.paths.add(placed.path);
    binding.readerScrolled();
    return geometry.binding;
  });
  // A code view's place comes from Pierre's line model, not the rows on the page, so a scroll whose
  // frame has not run yet can still be read as the view or the page goes away.
  const hide = () => tracker.settle();
  // Registered after the tracker's own release handler, so the tracker has let go of the pointer.
  const release = () => {
    if (!binding.grewWhilePressed) return;
    binding.grewWhilePressed = false;
    if (!binding.readerMoved) placeAgain(binding);
  };
  if (codeView) {
    window.addEventListener("pagehide", hide);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
  }
  const binding: SourceBinding = {
    geometry,
    readerScrolled,
    readerMoved: false,
    contents: instance.file?.contents,
    grewWhilePressed: false,
    downloadBytes,
    tracker,
    dispose: () => {
      if (codeView) tracker.settle();
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      tracker.dispose();
    },
  };
  sourceBindings.set(fileContainer, binding);
  if (!codeView) sourceTrackerByFile.set(fileReadingId(file), tracker);
  if (verdict === "pending") return;
  const stored = readings.readPosition(file, "source");
  if (stored !== null) placed.paths.add(placed.path);
  // A read-only citation shown by an earlier release saved no place, so it shows centered, as then.
  const saved =
    stored ??
    (codeView && citedLine !== null && !placed.paths.has(placed.path)
      ? { view: "source" as const, line: citedLine, offset: 0, centered: true as const }
      : null);
  if (saved !== null) tracker.restore(geometry.binding, saved);
}

/**
 * Places a code view's place again, as its text grew. A citation past the end of a file whose
 * download ended saves the last line instead, as the reveal of a whole file does.
 */
function placeAgain(binding: SourceBinding): void {
  const { geometry, tracker } = binding;
  const anchor = tracker.anchor;
  if (anchor?.view !== "source") return;
  const last = geometry instanceof CodeViewGeometry ? geometry.lineCount() : anchor.line;
  if (
    anchor.centered === true &&
    anchor.line > last &&
    geometry instanceof CodeViewGeometry &&
    !geometry.partial(binding.downloadBytes)
  ) {
    landCitation(binding, last, null);
  } else {
    tracker.restore(geometry.binding, anchor);
  }
}

/**
 * The line a landed citation saves. A reveal stops at the end of the text shown: a download still
 * bringing more of the file can bring the cited line, text that arrived during the reveal's scroll
 * may hold it, and a finished file saves its last line, as the editor does.
 */
function citedPlace(binding: SourceBinding, cited: number | null, revealed: number): number {
  const { geometry } = binding;
  if (cited === null || revealed >= cited || !(geometry instanceof CodeViewGeometry))
    return revealed;
  return geometry.partial(binding.downloadBytes) ? cited : Math.min(cited, geometry.lineCount());
}

/**
 * Saves a landed citation's place, centered. A code view still downloading shows only part of the
 * file, so the reveal stopped at its last line; the cited line is saved, and placed as it arrives,
 * at once when it arrived while the reveal scrolled.
 */
function landCitation(binding: SourceBinding, cited: number, shown: number | null): void {
  const { geometry, tracker } = binding;
  const position = { ...geometry.centered(cited), centered: true as const };
  tracker.record(position);
  const reach =
    geometry instanceof CodeViewGeometry ? Math.min(cited, geometry.lineCount()) : cited;
  if (reach !== shown) tracker.restore(geometry.binding, position);
}

/** What the panel's line reveal asks of the reading position. */
export interface LineRevealHooks {
  /** The tab's cited line, marked in the file also after it was revealed. */
  readonly citedLine: number | null;
  /** Asked just before a reveal scrolls: false when the reader's saved place is shown instead. */
  readonly keepReveal: (fileContainer: HTMLElement) => boolean;
  /** A saved source position restores the code view, so the panel's own offset stays out. */
  readonly restoresSavedScroll: () => boolean;
  /** A reveal landed on `line`. */
  readonly onRevealApplied: (fileContainer: HTMLElement, line: number) => void;
}

/**
 * Where the file panel's current file was last read. A line reveal the tab has not shown yet
 * wins over the saved position; once shown, the saved position wins.
 */
export function useFileReadingPosition(input: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  /** The tab's own path, as the right panel store names it. */
  readonly requestedPath: string | null;
  readonly cwd: string;
  /** The workspace file shown, or null for an attachment. */
  readonly relativePath: string | null;
  /** The chat attachment shown, which is kept by its id. */
  readonly attachment?:
    | { readonly id: string; readonly name: string; readonly mimeType: string }
    | undefined;
  readonly revealLine: number | null;
  /** A large file's size in bytes while the panel shows its text as it downloads, else null. */
  readonly downloadBytes?: number | null;
}) {
  const threadKey = scopedThreadKey(input.threadRef);
  const [placedPaths] = useState(() => new Set<string>());
  const surface = useRightPanelStore((state) =>
    liveFileSurface(state.byThreadKey[threadKey], input.requestedPath),
  );
  const verdict = ledger.verdict(surface);
  const file =
    input.relativePath === null
      ? null
      : pathReadingKey(input.environmentId, resolvePathLinkTarget(input.relativePath, input.cwd));
  const viewMount = () => {
    const newest =
      verdict === "shown" && file !== null
        ? readings.newestView(file, ["source", "rendered", "offset"])
        : null;
    return { surface, renderedAllowed: newest !== null && newest !== "source" };
  };
  // A reveal that lands while this file's view is mounted must not flip it to rendered.
  const [mounted, setMounted] = useState(viewMount);
  if (mounted.surface !== surface) setMounted(viewMount());
  const placed: FileReadingKey | undefined =
    input.attachment === undefined
      ? (file ?? undefined)
      : {
          kind: "attachment",
          environmentId: input.environmentId,
          attachmentId: input.attachment.id,
        };
  // AttachmentFilePreview shows an attachment by its content type, the panel a file by its name.
  const kind = input.attachment === undefined ? null : filePreviewKind(input.attachment);
  const framed =
    kind === null
      ? isBrowserPreviewFile(input.relativePath ?? "")
      : kind === "pdf" || kind === "html";
  const place = useViewerPlace({
    file: placed,
    // A frame or PDF.js keeps its own place.
    views: framed ? NO_VIEWS : input.attachment === undefined ? PATH_VIEWS : ATTACHMENT_VIEWS,
    citation:
      verdict === "pending" && input.revealLine !== null && surface !== undefined
        ? {
            id: ledger.generation(surface),
            line: input.revealLine,
            pending: () => ledger.verdict(surface) === "pending",
            shown: () => ledger.markShown(threadKey, surface),
          }
        : null,
  });

  // A reader who scrolls a code view while it scrolls to a citation cuts that scroll short (CodeView
  // reports it cancelled), so from then on the reader's place wins over the citation.
  const readerTookOver = () => {
    if (surface !== undefined && ledger.verdict(surface) === "pending") {
      ledger.markShown(threadKey, surface);
    }
  };
  return {
    /** The reading key of the file or attachment shown. */
    file: placed,
    /** The ref for the element that holds the viewer, which keeps the place of most viewers. */
    placeRef: place.ref,
    rowLine: place.rowLine,
    /** The line still to reveal: a citation the tab already showed is not revealed again. */
    scrollLine: verdict === "shown" ? null : input.revealLine,
    citedLine: input.revealLine,
    revealKey: ledger.generation(surface),
    renderedAllowed: mounted.renderedAllowed,
    // A reopened tab whose citation was shown, or a stale reveal, restores the reader's place.
    keepReveal: (fileContainer: HTMLElement) => {
      if (file === null || ledger.verdict(surface) !== "shown") return true;
      const binding = sourceBindings.get(fileContainer);
      if (binding === undefined) return true;
      // A code view the reader scrolled already shows the reader's place.
      if (binding.readerMoved) return false;
      const saved = readings.readPosition(file, "source");
      if (saved === null) return true;
      binding.tracker.restore(binding.geometry.binding, saved);
      return false;
    },
    restoresSavedScroll: () => file !== null && readings.readPosition(file, "source") !== null,
    onRevealApplied: (fileContainer: HTMLElement, line: number) => {
      if (surface !== undefined) ledger.markShown(threadKey, surface);
      if (input.relativePath !== null) placedPaths.add(input.relativePath);
      const binding = sourceBindings.get(fileContainer);
      if (binding === undefined) return;
      // The view shows the citation now, not where the reader scrolled before it.
      binding.readerMoved = false;
      landCitation(binding, citedPlace(binding, input.revealLine, line), line);
    },
    /** Keeps the reader's place in the code view the line reveal draws into. */
    trackSource:
      (reveal: (scroller: SourceScroller) => FilePostRender) =>
      (scroller: SourceScroller): FilePostRender => {
        const revealIn = reveal(scroller);
        return (fileContainer, instance, phase) => {
          revealIn(fileContainer, instance, phase);
          if (file === null || !(instance instanceof VirtualizedFile)) return;
          // A landed reveal does not re-render the panel, so ask the ledger now.
          const verdict = ledger.verdict(surface);
          const readerScrolled = scroller === "codeView" ? readerTookOver : ignoreScroll;
          trackSourceView(
            fileContainer,
            instance,
            phase,
            file,
            verdict,
            scroller,
            readerScrolled,
            input.revealLine,
            { paths: placedPaths, path: input.relativePath ?? "" },
            input.downloadBytes ?? null,
          );
        };
      },
    caretLine: (): number | "first-visible" => {
      const anchor = file === null ? null : sourceTrackerByFile.get(fileReadingId(file))?.anchor;
      return (
        (ledger.verdict(surface) === "pending" ? input.revealLine : null) ??
        // A place that starts inside its line, as a read-only view saves, names a line cut at the
        // top, so the caret goes to the next one, the line the editor itself saves as its place.
        (anchor?.view === "source" ? anchor.line + (anchor.offset > 0 ? 1 : 0) : undefined) ??
        "first-visible"
      );
    },
  };
}
