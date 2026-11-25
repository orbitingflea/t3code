import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import ChatMarkdown from "../../components/ChatMarkdown";
import { ComposerContextActionsContext } from "../../components/composerContextActions";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../../components/ComposerPromptEditorTiptap";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { OpenOriginContext, useChatFileOpener } from "../workArea/chatFileOpener";
import {
  leaves,
  PRIMARY_CHAT,
  resolveLayout,
  secondaryChatTabId,
  surfaceTabId,
  type TabId,
} from "../workArea/workArea.logic";
import { postWhiteboardHover, showBoardRef } from "./boardChannel";
import { WhiteboardPanel } from "./WhiteboardPanel";

const role = vi.hoisted(() => ({ projectRoot: "/project" }));

vi.mock("./role", () => ({
  useBoardHostRole: () => ({ menu: {} }),
  isBoardHost: () => true,
  isTopWindow: () => true,
  boardOfferedFor: () => true,
  useBoardOfferedFor: () => true,
  readThreadProjectRoot: () => role.projectRoot,
  useThreadProjectRoot: () => role.projectRoot,
}));

type BoardWindow = Window & { kept?: boolean; received?: unknown[] };

// Each test has its own thread and project, so boards a test leaves loaded never meet another test.
function setup(name: string, { board = true } = {}) {
  role.projectRoot = `/project-${name}`;
  const threadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(`thread-${name}`));
  if (board) useRightPanelStore.getState().open(threadRef, "whiteboard");
  return threadRef;
}

function Panes(props: {
  readonly at: "left" | "right" | null;
  readonly threadRef: ReturnType<typeof setup>;
  readonly sheet?: boolean;
}) {
  const pane = (side: "left" | "right") => (
    <div data-pane={side} style={{ position: "relative", display: "flex", width: 400 }}>
      {props.at === side ? <WhiteboardPanel threadRef={props.threadRef} /> : null}
    </div>
  );
  return (
    <div
      data-slot={props.sheet ? "sheet-popup" : undefined}
      style={{ display: "flex", height: 300 }}
    >
      {pane("left")}
      {pane("right")}
    </div>
  );
}

const shownFrame = (container: HTMLElement) =>
  container.querySelector<HTMLIFrameElement>('iframe[title="Whiteboard"]');

// The board page's own `wb-ready`, posted from inside the frame so the frame is its source.
async function loadedBoard(container: HTMLElement): Promise<BoardWindow> {
  const board = await vi.waitFor(() => {
    const window = shownFrame(container)?.contentWindow as BoardWindow | null | undefined;
    expect(window?.location.search).toContain("embed=panel");
    expect(window?.document.readyState).toBe("complete");
    return window!;
  });
  board.kept = true;
  board.received = [];
  board.addEventListener("message", (event) => board.received!.push(event.data));
  (board as Window & { eval: (code: string) => void }).eval(
    'parent.postMessage({ type: "wb-ready" }, location.origin)',
  );
  return board;
}

// Hover with no reference only clears a mark, which is harmless at any time.
const isNotAHoverEnd = (message: unknown) => {
  const { type, ref } = message as { type?: unknown; ref?: unknown };
  return type !== "wb-hover" || ref !== null;
};

const surfaceKinds = (threadRef: ScopedThreadRef) =>
  useRightPanelStore
    .getState()
    .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.map((surface) => surface.kind);

/** The thread's Whiteboard tab as the work area shows it: mounted while the record lists it. */
function ListedBoard(props: { readonly threadRef: ScopedThreadRef }) {
  const listed = useRightPanelStore(
    (state) =>
      state.byThreadKey[scopedThreadKey(props.threadRef)]?.surfaces.some(
        (surface) => surface.kind === "whiteboard",
      ) === true,
  );
  return (
    <div style={{ position: "relative", display: "flex", width: 400, height: 300 }}>
      {listed ? <WhiteboardPanel threadRef={props.threadRef} /> : null}
    </div>
  );
}

const ownLayout = (threadRef: ScopedThreadRef) =>
  resolveLayout(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef));

/** The index of the pane that shows `tab`, and whether that pane has focus. */
function paneShowing(threadRef: ScopedThreadRef, tab: TabId) {
  const layout = ownLayout(threadRef);
  const panes = leaves(layout.root);
  const index = panes.findIndex((pane) => pane.active === tab);
  return { index, focused: panes[index]?.id === layout.focused };
}

const ignore = () => {};

/** The composer as ChatView draws it: inside the primary Chat's origin. */
function ChipComposer(props: { readonly threadRef: ScopedThreadRef; readonly value: string }) {
  return (
    <OpenOriginContext value={{ kind: "own", tab: PRIMARY_CHAT }}>
      <ChipEditor {...props} />
    </OpenOriginContext>
  );
}

function ChipEditor(props: { readonly threadRef: ScopedThreadRef; readonly value: string }) {
  const opener = useChatFileOpener(props.threadRef);
  return (
    <ComposerContextActionsContext
      value={{
        environmentId: props.threadRef.environmentId,
        expandImage: ignore,
        expandVideo: ignore,
        openFile: ignore,
        openMention: (path) => opener?.().openMention(path),
        openPullRequest: ignore,
      }}
    >
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={props.value}
        cursor={props.value.length}
        richTextEnabled
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={ignore}
        onPaste={ignore}
        onCommandKeyDown={() => false}
      />
    </ComposerContextActionsContext>
  );
}

function closeWhiteboardTab(threadRef: ReturnType<typeof setup>) {
  const surfaces = useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)]?.surfaces;
  for (const surface of surfaces ?? [])
    if (surface.kind === "whiteboard")
      useRightPanelStore.getState().closeSurface(threadRef, surface.id);
}

describe("WhiteboardPanel", () => {
  it("keeps its board page loaded while hidden and when it moves to the other pane", async () => {
    const threadRef = setup("keep");
    await using screen = await render(<Panes at="left" threadRef={threadRef} />, { router: false });
    const board = await loadedBoard(screen.container);

    for (const at of [null, "left", null, "right", "left"] as const) {
      await screen.rerender(<Panes at={at} threadRef={threadRef} />);
      if (at === null) continue;
      expect(shownFrame(screen.container)?.closest("[data-pane]")?.getAttribute("data-pane")).toBe(
        at,
      );
      expect((shownFrame(screen.container)?.contentWindow as BoardWindow | null)?.kept).toBe(true);
    }
    expect(shownFrame(screen.container)?.contentWindow).toBe(board);
    closeWhiteboardTab(threadRef);
  });

  it("highlights a link clicked while hidden in the loaded board, once, and pauses it while hidden", async () => {
    const threadRef = setup("link");
    await using screen = await render(<Panes at="left" threadRef={threadRef} />, { router: false });
    const board = await loadedBoard(screen.container);
    await screen.rerender(<Panes at={null} threadRef={threadRef} />);

    postWhiteboardHover("board://r/1,2,3,4", document.createElement("a"));
    showBoardRef("board://r/5,6,7,8", threadRef);
    await screen.rerender(<Panes at="left" threadRef={threadRef} />);

    await vi.waitFor(() =>
      expect(board.received).toContainEqual({ type: "wb-highlight", ref: "board://r/5,6,7,8" }),
    );
    expect(shownFrame(screen.container)?.contentWindow).toBe(board);
    expect(board.received!.filter(isNotAHoverEnd)).toEqual([
      { type: "wb-visible", visible: false },
      { type: "wb-visible", visible: true },
      { type: "wb-highlight", ref: "board://r/5,6,7,8" },
    ]);
    closeWhiteboardTab(threadRef);
  });

  it("keeps a click that opened the board while it moves to the other pane before it is ready", async () => {
    const threadRef = setup("move");
    await using screen = await render(<Panes at="left" threadRef={threadRef} />, { router: false });
    showBoardRef("board://r/5,6,7,8", threadRef);
    await screen.rerender(<Panes at="right" threadRef={threadRef} />);

    const board = await loadedBoard(screen.container);
    await vi.waitFor(() =>
      expect(board.received).toEqual([{ type: "wb-highlight", ref: "board://r/5,6,7,8" }]),
    );
    closeWhiteboardTab(threadRef);
  });

  it("leaves its board unloaded when the sheet opens again after its last tab closed", async () => {
    const threadRef = setup("evicted");
    await using screen = await render(<Panes at="left" threadRef={threadRef} sheet />, {
      router: false,
    });
    const frame = shownFrame(screen.container)!;
    await loadedBoard(screen.container);
    closeWhiteboardTab(threadRef);
    useRightPanelStore.getState().show(threadRef);
    expect(frame.isConnected).toBe(false);
  });

  it("holds a link for a board page that reloads until that page is ready again", async () => {
    const threadRef = setup("reload");
    await using screen = await render(<Panes at="left" threadRef={threadRef} />, { router: false });
    const board = await loadedBoard(screen.container);
    await expect.element(screen.getByText("Loading board...")).not.toBeInTheDocument();
    (board as Window & { eval: (code: string) => void }).eval(
      'parent.postMessage({ type: "wb-unload" }, location.origin)',
    );
    await expect.element(screen.getByText("Loading board...")).toBeInTheDocument();
    showBoardRef("board://r/5,6,7,8", threadRef);
    // Messages from one window arrive in order, so a highlight sent now would arrive before this.
    board.postMessage({ type: "probe" }, location.origin);
    await vi.waitFor(() => expect(board.received).toContainEqual({ type: "probe" }));
    expect(board.received!.filter(isNotAHoverEnd)).toEqual([{ type: "probe" }]);
    board.received = [];

    (board as Window & { eval: (code: string) => void }).eval(
      'parent.postMessage({ type: "wb-ready" }, location.origin)',
    );
    await vi.waitFor(() =>
      expect(board.received).toEqual([{ type: "wb-highlight", ref: "board://r/5,6,7,8" }]),
    );
    closeWhiteboardTab(threadRef);
  });

  it("opens a board link from a secondary Chat in the owner's Whiteboard beside it and highlights it there", async () => {
    const owner = setup("secondary", { board: false });
    const guest = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread-guest"));
    useRightPanelStore.getState().updateWorkArea(owner, {
      type: "place",
      source: { threads: [guest] },
      at: { kind: "edge", pane: leaves(ownLayout(owner).root)[0]!.id, edge: "right" },
    });
    const tab = secondaryChatTabId(guest);
    const payload = ownLayout(owner).tabs[tab];
    const placement = payload?.kind === "secondary-chat" ? payload.placement : -1;
    await using screen = await render(
      <>
        <OpenOriginContext value={{ kind: "shown", owner, tab, placement }}>
          <ChatMarkdown cwd={undefined} threadRef={guest} text="See [Area 1](board://r/5,6,7,8)." />
        </OpenOriginContext>
        <ListedBoard threadRef={owner} />
      </>,
    );
    await userEvent.click(screen.getByRole("link", { name: "Area 1" }));
    expect(surfaceKinds(owner)).toContain("whiteboard");
    expect(surfaceKinds(guest)).toBeUndefined();
    expect(paneShowing(owner, surfaceTabId("whiteboard"))).toEqual({ index: 0, focused: true });
    expect(paneShowing(owner, tab).index).toBe(1);

    const board = await loadedBoard(screen.container);
    await vi.waitFor(() =>
      expect(board.received).toContainEqual({ type: "wb-highlight", ref: "board://r/5,6,7,8" }),
    );
    closeWhiteboardTab(owner);
  });

  it("highlights a composer whiteboard chip's region in the board already shown, opening no file", async () => {
    const threadRef = setup("chip");
    await using screen = await render(
      <>
        <ChipComposer threadRef={threadRef} value="[Area 1](board://r/5,6,7,8) " />
        <Panes at="left" threadRef={threadRef} />
      </>,
    );
    const board = await loadedBoard(screen.container);
    const chip = await vi.waitFor(() => {
      const element = screen.container.querySelector<HTMLElement>("[data-composer-mention-chip]");
      expect(element?.textContent).toBe("Area 1");
      return element!;
    });
    await userEvent.click(chip);
    expect(surfaceKinds(threadRef)).toEqual(["whiteboard"]);

    await vi.waitFor(() =>
      expect(board.received).toContainEqual({ type: "wb-highlight", ref: "board://r/5,6,7,8" }),
    );
    closeWhiteboardTab(threadRef);
  });

  it("opens a closed board beside the primary Chat from a composer chip and highlights it there", async () => {
    const threadRef = setup("chip-closed", { board: false });
    const store = useRightPanelStore.getState();
    store.openFile(threadRef, "a.ts");
    store.openFile(threadRef, "b.ts");
    const filesPane = leaves(ownLayout(threadRef).root)[1]!.id;
    store.updateWorkArea(threadRef, {
      type: "place",
      source: { view: { pane: filesPane, tab: surfaceTabId("file:b.ts") } },
      at: { kind: "edge", pane: filesPane, edge: "right" },
    });
    await using screen = await render(
      <>
        <ChipComposer threadRef={threadRef} value="[Area 1](board://r/5,6,7,8) " />
        <ListedBoard threadRef={threadRef} />
      </>,
    );
    const chip = await vi.waitFor(() => {
      const element = screen.container.querySelector<HTMLElement>("[data-composer-mention-chip]");
      expect(element?.textContent).toBe("Area 1");
      return element!;
    });
    await userEvent.click(chip);
    expect(paneShowing(threadRef, surfaceTabId("whiteboard"))).toEqual({
      index: 1,
      focused: true,
    });
    expect(surfaceKinds(threadRef)).toEqual(["file", "file", "whiteboard"]);

    const board = await loadedBoard(screen.container);
    await vi.waitFor(() =>
      expect(board.received).toContainEqual({ type: "wb-highlight", ref: "board://r/5,6,7,8" }),
    );
    closeWhiteboardTab(threadRef);
  });

  it("unloads its board when the Whiteboard tab closes", async () => {
    const threadRef = setup("close");
    await using screen = await render(<Panes at="left" threadRef={threadRef} />, { router: false });
    const frame = shownFrame(screen.container)!;
    await loadedBoard(screen.container);
    await screen.rerender(<Panes at={null} threadRef={threadRef} />);

    closeWhiteboardTab(threadRef);
    expect(frame.isConnected).toBe(false);
  });
});
