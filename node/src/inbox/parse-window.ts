/**
 * Parse inbox time window specs into an ISO 8601 cutoff (UTC).
 * All relative specs use a rolling window from now.
 * Supports hours (h), days (d), weeks (w), months (30×24h), years (365×24h); bare number = days.
 * Also accepts YYYY-MM-DD (messages on or after that instant at UTC midnight).
 */
const ROLLING_REGEX = /^(\d+)([dhmwy])?$/i;

const HOURS_PER_UNIT: Record<string, number> = {
  h: 1,
  d: 24,
  w: 24 * 7,
  m: 24 * 30,
  y: 24 * 365,
};

const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseInboxWindowToIsoCutoff(spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("Inbox window spec is empty.");
  }

  const dateOnly = trimmed.match(ISO_DATE_ONLY);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return `${y}-${mo}-${d}T00:00:00.000Z`;
  }

  const match = trimmed.match(ROLLING_REGEX);
  if (!match) {
    throw new Error(
      `Invalid inbox window: "${spec}". Use e.g. 24h, 3d, 1w, or YYYY-MM-DD.`
    );
  }

  const num = parseInt(match[1], 10);
  const unit = (match[2] ?? "d").toLowerCase();
  const hoursPer = HOURS_PER_UNIT[unit];
  if (!hoursPer || num <= 0) {
    throw new Error(`Invalid inbox window: "${spec}". Number must be positive.`);
  }

  const msAgo = num * hoursPer * 60 * 60 * 1000;
  return new Date(Date.now() - msAgo).toISOString();
}
