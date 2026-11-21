import { useClientSettings } from "../hooks/useSettings";
import { type FileLinkPathMeta, fileLinkPathPrefix } from "./fileLinkPathDepth";

export function useFileLinkPrefix(parentSuffixByPath: ReadonlyMap<string, string>) {
  const depth = useClientSettings((settings) => settings.fileLinkPathDepth);
  return (meta: FileLinkPathMeta) => fileLinkPathPrefix(meta, parentSuffixByPath, depth);
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
