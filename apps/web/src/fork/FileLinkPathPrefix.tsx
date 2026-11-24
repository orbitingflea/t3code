import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useClientSettings } from "../hooks/useSettings";
import { serverEnvironment } from "../state/server";
import { type FileLinkPathMeta, fileLinkPathPrefix, repeatedFileNames } from "./fileLinkPathDepth";

// Only the home string and the OS flag, so other config updates do not re-render every message.
const serverHomeAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) => get(serverEnvironment.configValueAtom(environmentId))?.homeDirectory || null,
  ).pipe(Atom.withLabel(`file-link-server-home:${environmentId}`)),
);
const serverWindowsAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.configValueAtom(environmentId))?.environment.platform.os === "windows",
  ).pipe(Atom.withLabel(`file-link-server-windows:${environmentId}`)),
);

export function useFileLinkPrefix(
  parentSuffixByPath: ReadonlyMap<string, string>,
  environmentId: EnvironmentId | null,
) {
  const depth = useClientSettings((settings) => settings.fileLinkPathDepth);
  const home = useAtomValue(serverHomeAtom(environmentId));
  const windows = useAtomValue(serverWindowsAtom(environmentId));
  const view = { depth, home, windows, repeatedNames: repeatedFileNames(parentSuffixByPath) };
  return (meta: FileLinkPathMeta) => fileLinkPathPrefix(meta, view);
}

/**
 * A file link's label with its folders drawn before the name. The folders are generated
 * content, so the label's text, which thread find and copy read, stays the same. In this
 * right-to-left box they come after the name, so a narrow chip clips their start first.
 */
export function FileLinkPathLabel({
  prefix,
  label,
}: {
  prefix: string | undefined;
  label: string;
}) {
  if (prefix === undefined) return label;
  // 1.2em is the chip icon and its gap. Inline boxes only: a flex item would end a
  // triple-click selection at the chip.
  return (
    <span
      data-file-link-prefix={prefix}
      className="inline-block max-w-[calc(100%-1.2em)] overflow-x-clip text-ellipsis whitespace-nowrap align-bottom [direction:rtl] after:text-muted-foreground after:content-[attr(data-file-link-prefix)] after:[direction:ltr] after:[unicode-bidi:isolate]"
    >
      <span dir="ltr">{label}</span>
    </span>
  );
}
