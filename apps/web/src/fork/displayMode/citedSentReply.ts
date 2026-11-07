import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { sentMessageText } from "@t3tools/shared/displayModes";

/** Every display mode shows a completed `send_to_user` call as a reply, and quotes name it by its turn item id. */
export function isSentReply(item: ThreadStructureTurnItem, id: string): boolean {
  return item.id === id && item.type === "dynamic_tool" && sentMessageText(item) !== null;
}
