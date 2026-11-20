import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useQuietThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentShellHasSnapshot } from "~/state/shell";

/**
 * Whether a shown thread is gone: false while it may still render, null until its environment's
 * shell has loaded. A families server leaves idle children and older settled threads out.
 */
export function useThreadGone(thread: ScopedThreadRef): boolean | null {
  const shell = useQuietThreadShell(thread);
  const loaded = useEnvironmentShellHasSnapshot(thread.environmentId);
  const shellOmits =
    useAtomValue(serverEnvironment.configValueAtom(thread.environmentId))?.shellThreadFamilies ===
    true;
  if (shell !== null || shellOmits) return false;
  return loaded ? true : null;
}
