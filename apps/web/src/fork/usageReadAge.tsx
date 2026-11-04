import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { ClockIcon } from "lucide-react";

import { usePrimarySettings } from "../hooks/useSettings";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../timestampFormat";

/** Readings older than this show their age. */
const OLD_READING_MS = 20 * 60_000;

/** The window's reading time when the reading is more than 20 minutes old, else null. */
export function oldReadingAt(window: ServerProviderUsageWindow, now: number): string | null {
  const readAt = window.readAt;
  return readAt && now - Date.parse(readAt) > OLD_READING_MS ? readAt : null;
}

/** "11:24 · 2h ago" for a window from an old reading, else null. */
export function useOldReadingLabel(window: ServerProviderUsageWindow, now: number) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const readAt = oldReadingAt(window, now);
  return readAt
    ? `${formatShortTimestamp(readAt, timestampFormat)} · ${formatRelativeTimeLabel(readAt, now)}`
    : null;
}

/** A clock and "2h ago" beside a window whose numbers come from an old reading. */
export function OldReadingTag({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const readAt = oldReadingAt(window, now);
  if (!readAt) return null;
  const age = formatRelativeTimeLabel(readAt, now);
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-background/85 px-1 py-0.5 text-2xs text-muted-foreground tabular-nums">
      <ClockIcon className="size-3" aria-hidden />
      <span className="sr-only">Numbers read </span>
      {age}
    </span>
  );
}
