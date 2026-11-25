import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  isMarkdownFileLinkLabel,
  isWindowsDrivePathHref,
  normalizeMarkdownLinkDestination,
} from "@t3tools/shared/markdownLinks";
import { createContext, use } from "react";

import { isWebUrl } from "../../browser/webUrl";
import ChatMarkdown, { safeUrl } from "../../components/ChatMarkdown";
import { nodeToPlainText } from "../../components/chat/MarkdownCodeBlock.logic";
import { createMarkdownRenderer } from "../../components/chat/markdownRenderer";
import type { WordsHastOptions } from "../../markdown/wordsHast";
import {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "../../markdown-links";
import {
  hostFileAnchorHref,
  hostFileLinkHref,
  hostFileLinkLabel,
  useHostFileOrigins,
} from "../hostFileLinks";
import { useWebPanelLink } from "../workArea/chatAnchorLink";
import { startPanelLinkDrag } from "../workArea/panelLinkDrag";
import { dashboardLinkLabel, parseDashboardHref } from "./dashboardLink";

interface LinkScope {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
}

/** Where file references in a slot resolve and open. Without it they stay code and links. */
export const DashboardLinkScope = createContext<LinkScope | null>(null);

interface SlotCopy {
  readonly text: string;
  /** Every file path in the slot's current and read text, so both copies label chips alike. */
  readonly filePaths: readonly string[];
  readonly hostFileOrigins: readonly string[];
}

const SlotCopyContext = createContext<SlotCopy>({ text: "", filePaths: [], hostFileOrigins: [] });

/**
 * Chat's own file chip. `markdown` is a code span or an empty-label link built here, never
 * text from the slot, so nothing in it can suspend or parse differently from the slot.
 */
function ChatFileChip(props: { readonly markdown: string; readonly scope: LinkScope }) {
  const { filePaths } = use(SlotCopyContext);
  return (
    <ChatMarkdown
      inline
      text={props.markdown}
      cwd={props.scope.cwd}
      threadRef={props.scope.threadRef}
      fileLinkPeerPaths={filePaths}
    />
  );
}

function codeSpan(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Escapes a parsed destination so that the chip's own parse reads it back unchanged. */
function linkDestination(href: string): string {
  return href.replace(/[\\<>&]/g, "\\$&");
}

function normalizeHref(href: string): string {
  const destination = normalizeMarkdownLinkDestination(href);
  return rewriteMarkdownFileUriHref(destination) ?? destination;
}

function slotFilePaths(
  texts: readonly string[],
  cwd: string | undefined,
  hostFileOrigins: readonly string[],
): string[] {
  const paths = new Set<string>();
  for (const text of texts) {
    for (const href of extractMarkdownLinkHrefs(text)) {
      const linkPath = hostFileLinkHref(normalizeHref(href), hostFileOrigins);
      const path = resolveMarkdownFileLinkMeta(linkPath, cwd)?.filePath;
      if (path) paths.add(path);
    }
    for (const span of extractInlineCodeSpans(text)) {
      const path = resolveInlineCodeFileLinkMeta(span, cwd)?.filePath;
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

// The URL a click on `anchor` opens, when its written destination does not depend on the page's
// address: a full web address (`https:/host` opens as `https://host`) or a protocol-relative one.
// An emptied, fragment or relative destination, such as `http:notes` on an http page, gives none.
function standaloneWebHref(anchor: HTMLAnchorElement, written = ""): string | undefined {
  if (written.startsWith("//")) return anchor.href;
  return isWebUrl(written) && new URL(written).href === anchor.href ? anchor.href : undefined;
}

// Agent text without math, breaks or insights; no board on the Dashboard.
const DASHBOARD_MARKDOWN: WordsHastOptions = {
  math: false,
  breaks: false,
  escapeHtml: false,
  insights: false,
  extensions: {},
  agentText: true,
};

const renderMarkdown = createMarkdownRenderer({
  markdown: DASHBOARD_MARKDOWN,
  components: {
    a: function DashboardLink({ node, children, ...props }) {
      const scope = use(DashboardLinkScope);
      const { text, hostFileOrigins } = use(SlotCopyContext);
      const webPanelLink = useWebPanelLink(scope?.threadRef ?? null);
      // The user is already on the Dashboard.
      if (props.href && parseDashboardHref(props.href)) return dashboardLinkLabel(node, props.href);
      const href = props.href ? normalizeHref(props.href) : "";
      const linkPath = hostFileAnchorHref(href, node, hostFileOrigins);
      const fileLinkMeta =
        scope !== null && href !== "" ? resolveMarkdownFileLinkMeta(linkPath, scope.cwd) : null;
      if (scope === null || fileLinkMeta === null) {
        return (
          <a
            {...props}
            target="_blank"
            rel="noreferrer"
            onDragStart={(event) =>
              startPanelLinkDrag(
                event,
                webPanelLink(standaloneWebHref(event.currentTarget, props.href)),
              )
            }
          >
            {children}
          </a>
        );
      }
      const label = nodeToPlainText(children);
      const start = node?.position?.start.offset;
      const end = node?.position?.end.offset;
      const source = start !== undefined && end !== undefined ? text.slice(start, end) : "";
      const copyMarkdown =
        source.startsWith("[") && source.includes("](")
          ? source
          : `[${(label || fileLinkMeta.basename).replace(/[\\[\]]/g, "\\$&")}](${href})`;
      const chip = <ChatFileChip markdown={`[](<${linkDestination(href)}>)`} scope={scope} />;
      return isMarkdownFileLinkLabel(hostFileLinkLabel(label, hostFileOrigins), linkPath) ? (
        <span data-markdown-copy={copyMarkdown}>{chip}</span>
      ) : (
        <span data-markdown-copy={copyMarkdown}>
          <span className="whitespace-normal">{children} </span>
          {chip}
        </span>
      );
    },
    code: function DashboardCode({ node, children, ...props }) {
      const scope = use(DashboardLinkScope);
      if (scope !== null && node?.properties?.dataInlineCode != null) {
        const codeText = nodeToPlainText(children);
        if (resolveInlineCodeFileLinkMeta(codeText, scope.cwd) !== null) {
          return <ChatFileChip markdown={codeSpan(codeText)} scope={scope} />;
        }
      }
      return <code {...props}>{children}</code>;
    },
  },
  urlTransform: (url) =>
    rewriteMarkdownFileUriHref(url) ??
    (isWindowsDrivePathHref(url) || parseDashboardHref(url) ? url : safeUrl(url)),
});

/**
 * A slot's markdown: chat's syntax and file chips, rendered synchronously. `pairedText` is the
 * slot's other copy, current or read.
 */
export function DashboardMarkdown(props: { readonly text: string; readonly pairedText?: string }) {
  const scope = use(DashboardLinkScope);
  const hostFileOrigins = useHostFileOrigins(scope?.threadRef.environmentId ?? null);
  const filePaths = slotFilePaths(
    [props.text, props.pairedText ?? ""],
    scope?.cwd,
    hostFileOrigins,
  );
  const entry = renderMarkdown.parse(props.text);
  renderMarkdown.remember(props.text, entry);
  return (
    <SlotCopyContext value={{ text: props.text, filePaths, hostFileOrigins }}>
      {renderMarkdown.element(entry)}
    </SlotCopyContext>
  );
}
