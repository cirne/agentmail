/**
 * Parse a relative since spec (e.g. 7d, 5w, 3m, 2y) into a YYYY-MM-DD date string.
 * Unit suffixes: d = days, w = weeks, m = months (30 days), y = years (365 days).
 * Bare number defaults to days (e.g. "7" → 7 days).
 */
const SINCE_REGEX = /^(\d+)([dwmy])?$/i;

const DAYS_PER_UNIT: Record<string, number> = {
  d: 1,
  w: 7,
  m: 30,
  y: 365,
};

export function parseSinceToDate(since: string): string {
  const trimmed = since.trim();
  const match = trimmed.match(SINCE_REGEX);
  if (!match) {
    throw new Error(
      `Invalid --since value: "${since}". Use a number plus optional unit: d (days), w (weeks), m (months), y (years). Example: 7d, 5w, 3m, 2y.`
    );
  }
  const num = parseInt(match[1], 10);
  const unit = (match[2] ?? "d").toLowerCase();
  const daysPer = DAYS_PER_UNIT[unit];
  if (num <= 0) {
    throw new Error(`Invalid --since value: "${since}". Number must be positive.`);
  }
  const days = num * daysPer;
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}
