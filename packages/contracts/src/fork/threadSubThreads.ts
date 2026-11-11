import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { IsoDateTime, ThreadId } from "../baseSchemas.ts";

/** The id of a sub-thread's first message: a message id or a turn item id. */
export const SubThreadFirstId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const ThreadSubThread = Schema.Struct({
  firstId: SubThreadFirstId,
  /** When the user last read the sub-thread, or null if they never did. */
  readAt: Schema.NullOr(IsoDateTime),
  /** A few generated words on the sub-thread's subject, or null until the first one is written. */
  summary: Schema.NullOr(Schema.String),
});
export type ThreadSubThread = typeof ThreadSubThread.Type;

/** Only the sub-threads that have a read time or a summary. */
export const ThreadSubThreads = Schema.Struct({
  threadId: ThreadId,
  subThreads: Schema.Array(ThreadSubThread),
});
export type ThreadSubThreads = typeof ThreadSubThreads.Type;

export const THREAD_SUB_THREADS_WS_METHODS = {
  subscribe: "fork.threadSubThreads.subscribe",
  markRead: "fork.threadSubThreads.markRead",
} as const;

export const ThreadSubThreadsMarkReadInput = Schema.Struct({
  threadId: ThreadId,
  firstId: SubThreadFirstId,
  /** The time of the latest message the user saw. An earlier time than the stored one is ignored. */
  readAt: IsoDateTime,
});

export const WsSubscribeThreadSubThreadsRpc = Rpc.make(THREAD_SUB_THREADS_WS_METHODS.subscribe, {
  payload: Schema.Struct({ threadId: ThreadId }),
  success: ThreadSubThreads,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsThreadSubThreadsMarkReadRpc = Rpc.make(THREAD_SUB_THREADS_WS_METHODS.markRead, {
  payload: ThreadSubThreadsMarkReadInput,
  error: EnvironmentAuthorizationError,
});
