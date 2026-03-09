/**
 * Noreply/bot address detection.
 * Identifies automated sender addresses that should be filtered from people results.
 */

const NOREPLY_PATTERNS = [
  /^no-?reply@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^notifications?@/i,
  /^donotreply@/i,
  /^bounce/i,
  /^news(letter)?@/i,
  /^alerts?@/i,
];

/**
 * Check if an email address matches noreply/bot patterns.
 */
export function isNoreply(address: string): boolean {
  const lower = address.toLowerCase();
  return NOREPLY_PATTERNS.some((pattern) => pattern.test(lower));
}

/**
 * Check if an address is likely a bot/system account based on having many distinct display names.
 * Real people typically have 1-3 display name variants. Bots/notification systems use many.
 */
export function isLikelyBot(distinctDisplayNames: number): boolean {
  // If an address has more than 10 distinct display names, it's likely a bot/system
  return distinctDisplayNames > 10;
}
