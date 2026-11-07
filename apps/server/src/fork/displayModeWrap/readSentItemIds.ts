import type { ThreadId } from "@t3tools/contracts";
import { SEND_TO_USER_PAYLOAD_LIKE } from "@t3tools/shared/displayModes";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Returns the ids of the `send_to_user` calls that Find should also search. A search names a display
 * mode only when it comes from a screen that draws these calls as replies, so other clients get none.
 */
export const readSentItemIds = Effect.fn("readSentItemIds")(function* (
  sql: SqlClient.SqlClient,
  displayMode: string | undefined,
  threadIds: readonly ThreadId[],
) {
  if (displayMode === undefined) return new Set<string>();
  const rows = yield* sql<{ readonly turn_item_id: string }>`
    SELECT turn_item_id FROM orchestration_v2_projection_turn_items
    WHERE thread_id IN ${sql.in(threadIds)} AND type = 'dynamic_tool'
      AND payload_json LIKE ${SEND_TO_USER_PAYLOAD_LIKE}
  `;
  return new Set(rows.map((row) => row.turn_item_id));
});
