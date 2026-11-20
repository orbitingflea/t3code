import type { ReactNode } from "react";

import { type ChatFileOpener, type OpenOrigin, OpenOriginContext } from "./chatFileOpener";
import { ChatOpenerContext } from "./chatOpenerContext";

/** Gives a chat's content its open origin and its opener together. */
export function ChatOpenScope(props: {
  readonly origin: OpenOrigin | null;
  readonly opener: ChatFileOpener | null;
  readonly children: ReactNode;
}) {
  return (
    <OpenOriginContext value={props.origin}>
      <ChatOpenerContext value={props.opener}>{props.children}</ChatOpenerContext>
    </OpenOriginContext>
  );
}
