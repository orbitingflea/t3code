import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";

/**
 * Setup often runs as root for the server's account (`incus exec` sets no SUDO_USER), so its
 * own uid says little. The owner of a T3 home given on the command line or in T3CODE_HOME is
 * the best evidence of the server's user; without that evidence, root setup warns conditionally.
 */
export const browserSetupRootWarning = Effect.fn("browserSetup.rootWarning")(function* (input: {
  readonly baseDir: string;
  readonly baseDirGiven: boolean;
}) {
  const env = yield* HostProcess.Environment;
  if (PreviewBrowserHost.sandboxDisabled(env)) return undefined;
  const rootError = new PreviewBrowserHost.PreviewBrowserRootError().message;
  if (input.baseDirGiven) {
    const fs = yield* FileSystem.FileSystem;
    const owner = yield* fs.stat(input.baseDir).pipe(
      Effect.map((info) => info.uid),
      Effect.orElseSucceed(() => Option.none<number>()),
    );
    if (Option.isSome(owner)) {
      return owner.value === 0
        ? `The T3 home ${input.baseDir} belongs to root, so the T3 server likely runs as root. If it does: ${rootError}`
        : undefined;
    }
  }
  // Under sudo from another user, the server most likely runs as that user.
  if ((yield* HostProcess.UserId) !== 0 || (env.SUDO_USER ?? "root") !== "root") return undefined;
  return `Setup runs as root and cannot tell which user runs the T3 server; pass \`--base-dir\` with the server's T3 home to check. If the server runs as root: ${rootError}`;
});
