import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { ClockIcon } from "lucide-react";

import { usePrimarySettings } from "../hooks/useSettings";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../timestampFormat";

/** Readings older than this show their age. */
const OLD_READING_MS = 20 * 60_000;

/** The reading time when the reading is more than 20 minutes old, else null. */
export function oldReadingAt(limits: ServerProviderUsageLimits, now: number): string | null {
  const readAt = limits.readAt;
  return readAt && now - Date.parse(readAt) > OLD_READING_MS ? readAt : null;
}

/** "11:24 · 2h ago" for an old reading, else null. */
export function useOldReadingLabel(limits: ServerProviderUsageLimits, now: number) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const readAt = oldReadingAt(limits, now);
  return readAt
    ? `${formatShortTimestamp(readAt, timestampFormat)} · ${formatRelativeTimeLabel(readAt, now)}`
    : null;
}

/** A clock and "2h ago" beside an account whose numbers come from an old reading. */
export function OldReadingTag({
  limits,
  now,
}: {
  readonly limits: ServerProviderUsageLimits;
  readonly now: number;
}) {
  const readAt = oldReadingAt(limits, now);
  if (!readAt) return null;
  const age = formatRelativeTimeLabel(readAt, now);
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground tabular-nums">
      <ClockIcon className="size-3" aria-hidden />
      <span className="sr-only">Numbers read </span>
      {age}
    </span>
  );
}
