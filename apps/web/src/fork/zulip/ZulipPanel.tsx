import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { RefreshIcon } from "../../components/ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useZulipPanelRole } from "./zulipPanel";

// No allow-top-navigation: the framed page must never replace the T3 Code page. Scripts with
// same-origin storage (Zulip needs both) stay out of this page because the frame is another origin.
const ZULIP_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";

const RELOAD = "Reload Zulip";
const OPEN_IN_NEW_TAB = "Open Zulip in a new tab";

/** The right panel's Zulip tab: the machine's Zulip page in a frame, the same in every thread. */
export function ZulipPanel() {
  const role = useZulipPanelRole();
  if (role === "unknown") return null;
  if (role === "off") {
    return (
      <p className="p-4 text-center text-muted-foreground text-sm">Zulip is not available here.</p>
    );
  }
  return <ZulipFrame url={role.url} />;
}

function ZulipFrame(props: { readonly url: string }) {
  const [generation, setGeneration] = useState(0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-border/60 px-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={RELOAD}
                onClick={() => setGeneration((current) => current + 1)}
              />
            }
          >
            <RefreshIcon />
          </TooltipTrigger>
          <TooltipPopup>{RELOAD}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={OPEN_IN_NEW_TAB}
                render={<a href={props.url} target="_blank" rel="noreferrer" />}
              />
            }
          >
            <ExternalLink />
          </TooltipTrigger>
          <TooltipPopup>{OPEN_IN_NEW_TAB}</TooltipPopup>
        </Tooltip>
      </div>
      <iframe
        key={generation}
        title="Zulip"
        src={props.url}
        sandbox={ZULIP_FRAME_SANDBOX}
        allow="clipboard-write; fullscreen; autoplay"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0"
      />
    </div>
  );
}
