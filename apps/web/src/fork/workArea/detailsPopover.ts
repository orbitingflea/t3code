// The Details toggle sits in the Chat pane's tab bar right above the chat header, so the popover
// opens from the header's top edge.
export const fromHeaderTop = ({ anchor }: { anchor: { height: number } }) => -anchor.height;
