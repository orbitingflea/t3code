import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** How many path segments a chat file link shows: 1 is the file name alone. */
export const FileLinkPathDepth = Schema.Literals([1, 2, 3, 4, 5]);
export type FileLinkPathDepth = typeof FileLinkPathDepth.Type;

const DEFAULT_FILE_LINK_PATH_DEPTH: FileLinkPathDepth = 2;

/** Stored file link depth. A missing or invalid value defaults to 2 so client settings never fail. */
export const StoredFileLinkPathDepth = FileLinkPathDepth.pipe(
  Schema.catchDecoding(() => Effect.succeedSome(DEFAULT_FILE_LINK_PATH_DEPTH)),
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_FILE_LINK_PATH_DEPTH)),
);
