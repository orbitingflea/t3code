import { PresentationIcon } from "lucide-react";

import { ContextChip, ContextChipLabel } from "~/components/ContextChip";

import { postWhiteboardHover } from "./boardChannel";

export const BoardMentionIcon = () => <PresentationIcon aria-hidden />;

/** A composer mention of a board region: its label and the board's hover, never a workspace file. */
export function BoardMentionChip(props: {
  readonly label: string;
  readonly href: string;
  readonly onOpen: () => void;
}) {
  return (
    <ContextChip
      kind="mention"
      dir="ltr"
      render={<button type="button" />}
      onClick={props.onOpen}
      aria-label={`Show ${props.label} on the whiteboard`}
      contentEditable={false}
      spellCheck={false}
      data-composer-mention-chip="true"
      onMouseEnter={(event) => postWhiteboardHover(props.href, event.currentTarget)}
      onMouseLeave={() => postWhiteboardHover(null)}
    >
      <BoardMentionIcon />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </ContextChip>
  );
}
