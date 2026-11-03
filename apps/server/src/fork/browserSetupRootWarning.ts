import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";

/** PreviewBrowserRootError's advice without its claim that the server runs as root. */
const ROOT_SERVER_ADVICE =
  "Chrome's sandbox cannot start as root. Run T3 as a nonroot user. Otherwise set `T3CODE_SERVER_BROWSER_SANDBOX=0` in the T3 server's environment and restart the server; this disables Chrome's sandbox. Manual: `T3CODE_SERVER_BROWSER_SANDBOX=0 t3 serve`. Systemd: add `Environment=T3CODE_SERVER_BROWSER_SANDBOX=0` under `[Service]`, reload systemd, then restart the service. `t3 browser setup` cannot fix root sandboxing.";

/**
 * Returns the warning text or undefined; undefined when the browser sandbox is off. An existing
 * given T3 home decides by its owner: root warns, another user does not. Otherwise undefined when
 * setup is not root or runs under sudo from another user, and a conditional warning when the
 * given home's owner cannot be read or no home is given.
 */
export const browserSetupRootWarning = Effect.fn("browserSetup.rootWarning")(function* (input: {
  readonly baseDir: string;
  readonly baseDirGiven: boolean;
}) {
  const env = yield* HostProcess.Environment;
  if (PreviewBrowserHost.sandboxDisabled(env)) return undefined;
  if (input.baseDirGiven) {
    const fs = yield* FileSystem.FileSystem;
    const owner = yield* fs.stat(input.baseDir).pipe(
      Effect.map((info) => info.uid),
      Effect.orElseSucceed(() => Option.none<number>()),
    );
    if (Option.isSome(owner)) {
      return owner.value === 0
        ? `The T3 home ${input.baseDir} belongs to root, so the T3 server likely runs as root. If it does: ${ROOT_SERVER_ADVICE}`
        : undefined;
    }
  }
  // Under sudo from another user, the server most likely runs as that user.
  if ((yield* HostProcess.UserId) !== 0 || (env.SUDO_USER ?? "root") !== "root") return undefined;
  const unknownUser = input.baseDirGiven
    ? `Setup could not read the owner of the T3 home ${input.baseDir} (for example because it does not exist yet), so it cannot check which user runs the T3 server.`
    : "Setup runs as root and cannot tell which user runs the T3 server; pass `--base-dir` with the server's T3 home to check.";
  return `${unknownUser} If the server runs as root: ${ROOT_SERVER_ADVICE}`;
});
