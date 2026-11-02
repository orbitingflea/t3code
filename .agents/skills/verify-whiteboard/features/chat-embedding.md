# Chat panel

The board page shows this repository's T3 Code in a panel beside the board, loaded under `/chat/`. When the chat opens a project, the board switches to that project's room. A region marked on the board lands in the chat's composer. Either panel can be collapsed and brought back from the other.

## Sub-features

- `chat-load` the panel loads T3 Code through the page's `/chat/` proxy.
- `chat-room` the board follows the room of the chat's active project.
- `chat-ref` the Reference region tool inserts an `Area N` chip into the composer.
- `chat-collapse` collapsing the chat shows a Chat button on the board that restores it.
- `board-collapse` collapsing the board shows a Board button in the chat header that restores it.

## How to get to it (user POV)

- Open the board page; the chat is the right panel.
- Add or pick a project in the chat; the board changes room.
- Drag the divider between the panels to an edge, or focus it and press End (collapse chat) or Home (collapse board).

## Driving it with wb-verify

Preconditions: `vp i` and the whiteboard build of `apps/web` (see the skill's Launch); a run from `up --chat`; doctor passes, including the `/chat/` line.

- **Journey.** `node .agents/skills/verify-whiteboard/scripts/chat-journey.mjs <run>`. Exit 0, and the printed `steps` have a line for each of the five sub-features. On a fresh run it first dismisses T3's setup dialog and adds `<run>/project` through Add project, Local folder.
- **Proof.** Open `<run>/evidence/chat-*.png`: the loaded chat, a `wb`-written note on the project's board, the `Area 1` chip in the composer, each collapsed state with its button, and the restored layout.
- **T3 screens.** For anything inside the chat beyond these steps, follow [test-t3-app](../../test-t3-app/SKILL.md) against the run's `/chat/` URL.

## Gotchas

- The chat's T3 Code runs with no login and with the run's private HOME, so providers have no credentials. Sending a turn needs a provider login copied into that HOME by hand, and costs money.
- The folder field in Local folder starts with `~/`, which resolves under the run's private HOME. Replace it with the absolute path.
- In headless Chrome, dragging the divider toward the chat stops once the pointer is over the iframe, so the journey collapses the chat with the keyboard. Dragging toward the board works. Whether a real mouse hits the same limit is unverified.
- A fresh `t3-userdata` opens the "Set up T3 Code" dialog over the chat on first load.
