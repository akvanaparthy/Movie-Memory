// No server-only imports: validation that the client also reads uses this.

/**
 * One line of plain text. Runs of whitespace (tabs and newlines included)
 * become a single space, and control characters are dropped: they are
 * invisible, and Postgres cannot store NUL in a text column at all.
 *
 * Zero-width characters are kept on purpose. Some scripts and most emoji
 * sequences need them, so "is there anything visible here" is a separate
 * check (see movie.ts).
 */
export function toSingleLine(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
}
