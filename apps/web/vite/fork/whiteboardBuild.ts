// @effect-diagnostics-next-line nodeBuiltinImport:off -- Vite plugin runs before any Effect runtime.
import * as NodeFS from "node:fs";

import type { Plugin } from "vite-plus";

// Selected with VITE_T3_WHITEBOARD=1: the whiteboard serves this build behind its own `/chat/`
// prefix, and the manifest takes the board page's colour. Client code reads the same variable
// through apps/web/src/fork/whiteboard/build.ts.
export function whiteboardBuildPlugin(): Plugin | undefined {
  if (process.env.VITE_T3_WHITEBOARD !== "1") return undefined;
  return {
    name: "t3code:whiteboard-build",
    config: () => ({ base: "/chat/" }),
    // Vite copies the public directory into the output directory before writing the bundle.
    writeBundle(options) {
      if (!options.dir) return;
      const manifestPath = `${options.dir}/manifest.webmanifest`;
      const manifest = NodeFS.readFileSync(manifestPath, "utf8");
      NodeFS.writeFileSync(manifestPath, manifest.replaceAll("#161616", "#0a0a0a"));
    },
  };
}
