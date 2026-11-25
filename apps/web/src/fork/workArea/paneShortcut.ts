const SIDE_CHAT_PANE = "[data-side-chat-pane]";

export function pressedInPaneOf(event: KeyboardEvent, element: Element | null): boolean {
  const pane = element?.closest(SIDE_CHAT_PANE);
  return (
    pane != null && event.target instanceof Element && event.target.closest(SIDE_CHAT_PANE) === pane
  );
}
