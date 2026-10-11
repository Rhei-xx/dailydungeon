/**
 * Printed at the top of every email the game sends. Mail clients quote the
 * original below a reply, so wherever this line turns up again (usually as
 * "> ##- Reply above this line -##") everything from there down is history.
 */
export const REPLY_MARKER = "##- Reply above this line -##";

const MARKER_CORE = "reply above this line";

/** Hard cap on what's handed to the parser — a move is a sentence or two. */
export const MAX_REPLY_CHARS = 2000;

function isAttributionStart(line: string, next: string | undefined): boolean {
  // Gmail / Apple Mail: "On Sat, Oct 11, 2026 at 7:03 AM Daily Dungeon <bot@gmail.com> wrote:"
  if (/^On\b.*\bwrote:\s*$/i.test(line)) return true;
  // ...which Gmail hard-wraps when long: "On Sat, ... Daily Dungeon <" / "bot@gmail.com> wrote:"
  const wrapped = next !== undefined && /wrote:\s*$/i.test(next.trim());
  if (/^On\b.*\d/.test(line) && wrapped) return true;
  // Other locales and clients that put the date first: "2026-10-11 7:03 GMT-04:00, Daily Dungeon <...>:"
  if (/^\d{4}-\d{2}-\d{2}.*<[^>]+@[^>]+>.*:\s*$/.test(line)) return true;
  return false;
}

/** Outlook's quoted header block: "From: ...", then "Sent:"/"Date:" within a couple of lines. */
function isOutlookHeader(lines: string[], i: number): boolean {
  if (!/^From:\s.+/i.test(lines[i].trim())) return false;
  return lines.slice(i + 1, i + 4).some((l) => /^(Sent|Date):\s.+/i.test(l.trim()));
}

/**
 * Pull just the player's new words out of a reply body: cut at the first
 * sign of quoted history (our marker, an "On … wrote:" attribution, Outlook's
 * header block or separator, or a ">"-quoted line), drop a trailing
 * signature, and cap the length.
 */
export function extractReplyText(body: string, maxChars = MAX_REPLY_CHARS): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.toLowerCase().includes(MARKER_CORE)) break;
    if (line.startsWith(">")) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) break;
    if (/^_{8,}$/.test(line)) break;
    if (isAttributionStart(line, lines[i + 1])) break;
    if (isOutlookHeader(lines, i)) break;
    kept.push(lines[i]);
  }

  let text = kept.join("\n");
  const signature = text.search(/^-- ?$/m);
  if (signature >= 0) text = text.slice(0, signature);
  text = text
    .replace(/^\s*Sent from my .*$/gim, "")
    .replace(/^\s*Get Outlook for .*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
}
