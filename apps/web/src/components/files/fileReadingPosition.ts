import { VirtualizedFile, type File as FileInstance, type PostRenderPhase } from "@pierre/diffs";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { useRef, useState } from "react";

import { isBrowserPreviewFile } from "~/browser/openFileInPreview";
import { useClosedViewStore } from "~/closedViewStore";
import type { FileSurface } from "~/fork/workArea/workArea.logic";
import { useRightPanelPane } from "~/fork/workArea/tabStrip";
import { useRightPanelStore } from "~/rightPanelStore";

import {
  createRevealLedger,
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
// A workspace file's code view has its own tracker; an attachment's source view is the container's.
const PATH_VIEWS: ReadonlyArray<ReadingView> = ["rendered", "offset"];
const ATTACHMENT_VIEWS: ReadonlyArray<ReadingView> = ["rendered", "offset", "source"];

type FilePostRender = <LAnnotation>(
  fileContainer: HTMLElement,
  instance: FileInstance<LAnnotation, undefined>,
  phase: PostRenderPhase,
) => void;
type SourcePosition = ReadingPositionOf<"source">;

type SourceLines = Pick<
  VirtualizedFile<unknown, undefined>,
  "getLinePosition" | "getNumericScrollAnchor"
>;

class SourceGeometry {
  constructor(
    private readonly element: HTMLElement,
    private fileContainer: HTMLElement,
    private lines: SourceLines,
  ) {}

  follow(fileContainer: HTMLElement, lines: SourceLines): void {
    this.fileContainer = fileContainer;
    this.lines = lines;
  }

  target(position: SourcePosition): ScrollTarget | null {
    const line = this.lines.getLinePosition(position.line);
    return line === undefined ? null : { top: this.fileTop() + line.top + position.offset };
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

interface SourceBinding {
  readonly tracker: ReadingTracker;
  readonly geometry: SourceGeometry;
  readonly binding: Binding<SourcePosition>;
}
// Keyed by Pierre's file container: its unmount phase also fires when the file turns into a placeholder.
const sourceBindings = new WeakMap<HTMLElement, SourceBinding>();

function trackSourceView(
  fileContainer: HTMLElement,
  instance: SourceLines,
  phase: PostRenderPhase,
  file: FileReadingKey,
  verdict: RevealVerdict,
): void {
  const existing = sourceBindings.get(fileContainer);
  if (phase === "unmount") {
    existing?.tracker.dispose();
    sourceBindings.delete(fileContainer);
    return;
  }
  if (existing !== undefined) {
    existing.geometry.follow(fileContainer, instance);
    if (verdict === "pending") existing.tracker.stop();
    return;
  }
  const element = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
  if (element === null) return;
  const geometry = new SourceGeometry(element, fileContainer, instance);
  const binding = { element, geometry };
  const tracker = new ReadingTracker(element, file, (scrolled) =>
    scrolled === element ? binding : null,
  );
  sourceBindings.set(fileContainer, { tracker, geometry, binding });
  if (verdict === "pending") return;
  const saved = readings.readPosition(file, "source");
  if (saved !== null) tracker.restore(binding, saved);
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
  /** The tab when the store holds no surface for it; its object keys the line reveal. */
  readonly surface?: FileSurface | undefined;
  /** `surface`'s line was shown before a reload, which the ledger cannot see. */
  readonly revealShown?: boolean | undefined;
  readonly onRevealShown?: (() => void) | undefined;
}) {
  const threadKey = scopedThreadKey(input.threadRef);
  // This view's code container: two views of one file each keep their own reading place.
  const sourceContainer = useRef<HTMLElement | null>(null);
  // A tab open in several panes shows a line reveal in one view; the others keep their place.
  const leads = useRightPanelPane()?.leads ?? true;
  const surface = useRightPanelStore(
    (state) => input.surface ?? liveFileSurface(state.byThreadKey[threadKey], input.requestedPath),
  );
  const file =
    input.relativePath === null
      ? null
      : pathReadingKey(input.environmentId, resolvePathLinkTarget(input.relativePath, input.cwd));
  // Like an expired receipt, an expired saved place lets the line show again.
  if (
    input.revealShown === true &&
    input.surface !== undefined &&
    file !== null &&
    readings.newestView(file, ["source", "rendered", "offset"]) !== null
  ) {
    ledger.markShown(threadKey, input.surface);
  }
  const verdictOf = (): RevealVerdict => {
    const verdict = ledger.verdict(surface);
    return verdict === "pending" && !leads ? "none" : verdict;
  };
  const verdict = verdictOf();
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
            pending: () => verdictOf() === "pending",
            shown: () => {
              ledger.markShown(threadKey, surface);
              input.onRevealShown?.();
            },
          }
        : null,
  });

  return {
    /** The reading key of the file or attachment shown. */
    file: placed,
    /** The ref for the element that holds the viewer, which keeps the place of most viewers. */
    placeRef: place.ref,
    rowLine: place.rowLine,
    scrollLine: verdict === "pending" ? input.revealLine : null,
    revealKey: ledger.generation(surface),
    renderedAllowed: mounted.renderedAllowed,
    /** Asked just before a reveal scrolls: a reopened tab whose citation was shown restores instead. */
    keepReveal: (fileContainer: HTMLElement) => {
      if (file === null || verdictOf() !== "shown") return true;
      const saved = readings.readPosition(file, "source");
      const binding = sourceBindings.get(fileContainer);
      if (saved === null || binding === undefined) return true;
      binding.tracker.restore(binding.binding, saved);
      return false;
    },
    /** A saved source position restores the code view, so the panel's own offset stays out. */
    restoresSavedScroll: () => file !== null && readings.readPosition(file, "source") !== null,
    onRevealApplied: (fileContainer: HTMLElement, line: number) => {
      if (surface !== undefined) ledger.markShown(threadKey, surface);
      input.onRevealShown?.();
      const binding = sourceBindings.get(fileContainer);
      binding?.tracker.record(binding.geometry.centered(line));
    },
    trackSource:
      (reveal: FilePostRender): FilePostRender =>
      (fileContainer, instance, phase) => {
        reveal(fileContainer, instance, phase);
        if (file === null || !(instance instanceof VirtualizedFile)) return;
        sourceContainer.current = phase === "unmount" ? null : fileContainer;
        // A landed reveal does not re-render the panel, so ask the ledger now.
        trackSourceView(fileContainer, instance, phase, file, verdictOf());
      },
    caretLine: (): number | "first-visible" => {
      const container = sourceContainer.current;
      const anchor = container === null ? null : sourceBindings.get(container)?.tracker.anchor;
      return (
        (verdictOf() === "pending" ? input.revealLine : null) ??
        (anchor?.view === "source" ? anchor.line : undefined) ??
        "first-visible"
      );
    },
  };
}
