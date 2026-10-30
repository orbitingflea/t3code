// Mounts the resizable board and ChatSlot layout into the browser page.
import { StrictMode, createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Group,
  Panel,
  Separator,
  type GroupImperativeHandle,
  type Layout,
} from "react-resizable-panels";
import { Board, ShowChat } from "./board";
import { ChatSlot } from "./ChatSlot";
import "./style.css";

declare const __OPEN_VIEWS__: Record<string, "board" | "chat">;

const exportMode = new URLSearchParams(location.search).has("export");

// Dragging the divider past a panel's minimum collapses that panel. Its button brings it back at that
// minimum width, so the side already on screen changes as little as possible.
const boardMin = 35;
const chatMin = 20;
const saved = JSON.parse(localStorage.getItem("wb-layout") ?? "null") as { layout: Layout } | null;
const group = createRef<GroupImperativeHandle>();
// A hostname listed in the config's openViews opens showing only that side on every load.
const openView = __OPEN_VIEWS__[location.hostname];
const openLayout =
  openView === "board"
    ? { board: 100, chat: 0 }
    : openView === "chat"
      ? { board: 0, chat: 100 }
      : saved?.layout;
const showChat = () => group.current?.setLayout({ board: 100 - chatMin, chat: chatMin });
const showBoard = () => group.current?.setLayout({ board: boardMin, chat: 100 - boardMin });

function App() {
  const [hidden, setHidden] = useState<"board" | "chat" | null>(null);
  if (exportMode)
    return (
      <main>
        <Board exportMode />
      </main>
    );
  return (
    <main>
      <Group
        orientation="horizontal"
        groupRef={group}
        defaultLayout={openLayout}
        onLayoutChange={(layout) =>
          setHidden(layout.board === 0 ? "board" : layout.chat === 0 ? "chat" : null)
        }
        onLayoutChanged={(layout) => localStorage.setItem("wb-layout", JSON.stringify({ layout }))}
      >
        <Panel id="board" defaultSize="68%" minSize={`${boardMin}%`} collapsible>
          <ShowChat value={hidden === "chat" ? showChat : null}>
            <Board />
          </ShowChat>
        </Panel>
        <Separator className={hidden ? "divider collapsed" : "divider"} />
        <Panel id="chat" defaultSize="32%" minSize={`${chatMin}%`} collapsible>
          <ChatSlot boardHidden={hidden === "board"} showBoard={showBoard} />
        </Panel>
      </Group>
    </main>
  );
}

const app = <App />;
createRoot(document.getElementById("root")!).render(
  exportMode ? app : <StrictMode>{app}</StrictMode>,
);
