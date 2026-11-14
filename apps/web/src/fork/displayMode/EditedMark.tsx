import { PencilIcon } from "lucide-react";
import { use } from "react";

import { TimelineRowCtx } from "../../components/chat/timelineRowContext";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { formatChatTimestampTooltip } from "../../timestampFormat";

/** Under a message that a rewrite changed, where other chat apps mark an edited message. */
export function EditedMark(props: { readonly editedAt: string | undefined }) {
  if (props.editedAt === undefined) return null;
  const { timestampFormat } = use(TimelineRowCtx);
  return (
    <div className="mt-0.5 flex">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex select-none items-center gap-1 text-2xs text-muted-foreground" />
          }
        >
          <PencilIcon className="size-2.5" />
          Edited
        </TooltipTrigger>
        <TooltipPopup>{formatChatTimestampTooltip(props.editedAt, timestampFormat)}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
