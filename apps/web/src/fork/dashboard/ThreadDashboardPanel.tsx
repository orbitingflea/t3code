import {
  DASHBOARD_SLOT_TITLES,
  type DashboardSlotId,
  type ScopedThreadRef,
  type ThreadDashboard,
  type ThreadDashboardSlot,
} from "@t3tools/contracts";
import {
  ASSISTANT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { defaultUrlTransform } from "react-markdown";

import { AssistantSelectionToolbar } from "../../components/chat/AssistantSelectionToolbar";
import { createMarkdownRenderer } from "../../components/chat/markdownRenderer";
import { RelativeTime } from "../../components/RelativeTime";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { remarkEndLinksAtCjkPunctuation } from "../cjkLinkEnd";
import {
  type CiteAssistantText,
  dashboardCitationSourceProps,
  releaseDashboardCitationViewport,
} from "./dashboardCitation";
import { unreadCharacters } from "./dashboardDiff";
import { markThreadDashboardSlotSeen, threadDashboard } from "./threadDashboardState";
import "./dashboard.css";

// A plain synchronous path: no highlighted code blocks or file chips, so the text blocks the
// change marks are drawn on exist as soon as the card commits.
const renderMarkdown = createMarkdownRenderer({
  remarkPlugins: [...ASSISTANT_MARKDOWN_REMARK_PLUGINS, remarkEndLinksAtCjkPunctuation],
  rehypePlugins: CHAT_MARKDOWN_REHYPE_PLUGINS,
  components: {
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  },
  urlTransform: defaultUrlTransform,
});

const BLOCKS = "li,p,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote";
const HIGHLIGHT_NAME = "t3-dashboard-change";

interface TextBlock {
  readonly nodes: Text[];
  text: string;
}

/** The rendered text blocks (list items, paragraphs, table cells, ...) in document order. */
function collectBlocks(root: HTMLElement): TextBlock[] {
  const blocks = new Map<Element, TextBlock>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    const parent = text.parentElement;
    if (parent === null || (!text.data.trim() && !parent.closest("pre"))) continue;
    const closest = parent.closest(BLOCKS);
    const element = closest !== null && root.contains(closest) ? closest : root;
    const block = blocks.get(element) ?? { nodes: [], text: "" };
    blocks.set(element, block);
    block.nodes.push(text);
    block.text += text.data;
  }
  return [...blocks.values()];
}

function unreadRanges(blocks: ReadonlyArray<TextBlock>, flags: boolean[][]): Range[] {
  const ranges: Range[] = [];
  blocks.forEach((block, index) => {
    const marks = flags[index] ?? [];
    let offset = 0;
    for (const node of block.nodes) {
      let start = -1;
      for (let k = 0; k <= node.data.length; k++) {
        const unread = k < node.data.length && marks[offset + k] === true;
        if (unread && start < 0) start = k;
        if (!unread && start >= 0) {
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, k);
          ranges.push(range);
          start = -1;
        }
      }
      offset += node.data.length;
    }
  });
  return ranges;
}

/** Every card adds its ranges to one shared highlight, so a single `::highlight()` rule paints them. */
function sharedHighlight(): Highlight | null {
  if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") {
    return null;
  }
  const existing = CSS.highlights.get(HIGHLIGHT_NAME);
  if (existing !== undefined) return existing;
  const created = new Highlight();
  CSS.highlights.set(HIGHLIGHT_NAME, created);
  return created;
}

function DashboardCard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly slot: ThreadDashboardSlot;
  readonly onMarkSeen: (slot: DashboardSlotId, text: string) => void;
}) {
  const { slot, text, updatedAt } = props.slot;
  const readText = props.slot.seenText ?? "";
  const unread = text !== readText;
  const title = DASHBOARD_SLOT_TITLES[slot];
  const bodyRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints the unread characters as CSS highlight ranges over the committed text nodes, and removes them on change or unmount
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const highlight = sharedHighlight();
    if (!unread || text.trim() === "" || body === null || highlight === null) return;
    const blocks = collectBlocks(body);
    const read =
      readText.trim() === "" || readRef.current === null ? [] : collectBlocks(readRef.current);
    const ranges = unreadRanges(
      blocks,
      unreadCharacters(
        read.map((block) => block.text),
        blocks.map((block) => block.text),
      ),
    );
    for (const range of ranges) highlight.add(range);
    return () => {
      for (const range of ranges) highlight.delete(range);
    };
  }, [text, readText, unread]);

  const markSeen = () => {
    if (unread) props.onMarkSeen(slot, text);
  };
  const handleClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest("a,button")) return;
    if (window.getSelection()?.isCollapsed === false) return;
    markSeen();
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    event.preventDefault();
    markSeen();
  };

  return (
    <section
      aria-label={unread ? `${title}, changed. Mark as read` : title}
      data-slot={slot}
      data-unread={unread ? "" : undefined}
      tabIndex={unread ? 0 : -1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "rounded-lg border bg-card px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        unread && "cursor-pointer border-l-2 border-l-success",
      )}
    >
      <header className="mb-1 flex items-baseline justify-between gap-2 text-muted-foreground text-xs">
        <h3 className="font-medium">{title}</h3>
        {updatedAt === null ? null : (
          <span className="shrink-0 tabular-nums">
            <RelativeTime timestamp={updatedAt} />
          </span>
        )}
      </header>
      <div
        ref={bodyRef}
        {...(text.trim() === "" ? {} : dashboardCitationSourceProps(props.threadRef, slot))}
        className="chat-markdown min-w-0 text-foreground text-sm leading-relaxed [overflow-wrap:anywhere]"
      >
        {text.trim() === "" ? (
          <span className="text-muted-foreground text-xs">(empty)</span>
        ) : (
          renderMarkdown(text, true)
        )}
      </div>
      {unread && readText.trim() !== "" ? (
        <div ref={readRef} hidden>
          {renderMarkdown(readText, true)}
        </div>
      ) : null}
    </section>
  );
}

/** The Dashboard's cards in slot order. */
export function DashboardCards(props: {
  readonly threadRef: ScopedThreadRef;
  readonly dashboard: ThreadDashboard;
  readonly onMarkSeen: (slot: DashboardSlotId, text: string) => void;
  readonly onCite: CiteAssistantText;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const attachViewport = (element: HTMLDivElement) => {
    setViewport(element);
    return () => releaseDashboardCitationViewport(element);
  };
  return (
    <div
      ref={attachViewport}
      data-assistant-citation-viewport="true"
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3"
    >
      {props.dashboard.slots.map((slot) => (
        <DashboardCard
          key={slot.slot}
          threadRef={props.threadRef}
          slot={slot}
          onMarkSeen={props.onMarkSeen}
        />
      ))}
      {/* Outside every card, so a Cite click never reaches a card's mark-as-read handler. */}
      <AssistantSelectionToolbar
        viewport={viewport}
        threadRef={props.threadRef}
        onCite={props.onCite}
      />
    </div>
  );
}

export function ThreadDashboardPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onCite: CiteAssistantText;
}) {
  const { environmentId, threadId } = props.threadRef;
  const query = useEnvironmentQuery(threadDashboard({ environmentId, input: { threadId } }));
  const markSeen = useAtomCommand(markThreadDashboardSlotSeen, { reportFailure: false });
  if (query.data === null) {
    return query.error === null ? null : (
      <p className="p-3 text-muted-foreground text-sm">{query.error}</p>
    );
  }
  return (
    <DashboardCards
      threadRef={props.threadRef}
      dashboard={query.data}
      onCite={props.onCite}
      onMarkSeen={(slot, text) => {
        void markSeen({ environmentId, input: { threadId, slot, text } });
      }}
    />
  );
}
