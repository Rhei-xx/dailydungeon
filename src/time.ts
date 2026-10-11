/** Local calendar date + clock time in an IANA timezone (ported from the old
 *  dispatcher's `localParts`). */
export function localParts(now: Date, timeZone: string): { isoDate: string; hhmm: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) parts[part.type] = part.value;
  const hour = parts.hour === "24" ? "00" : parts.hour; // normalize midnight
  return { isoDate: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${hour}:${parts.minute}` };
}

/** The daily run goes once a day, on the first tick at or after the local
 *  delivery time — so a delayed or skipped GitHub schedule just runs late,
 *  and daylight-saving changes need no cron edits. */
export function isDue(
  now: Date,
  timeZone: string,
  deliveryTime: string,
  lastRunLocalDate: string | undefined,
): boolean {
  const { isoDate, hhmm } = localParts(now, timeZone);
  return hhmm >= deliveryTime && lastRunLocalDate !== isoDate;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
