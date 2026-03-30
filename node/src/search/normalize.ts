/**
 * Address normalization for identity clustering.
 * Normalizes email addresses to a canonical form for comparison.
 */

/**
 * Normalize an email address for clustering purposes.
 * - Lowercases the entire address
 * - Strips dots from the local-part (Gmail ignores them; safe universally for consumer domains)
 * - Strips `+` aliases (e.g., `lewiscirne+bounti@gmail.com` -> `lewiscirne@gmail.com`)
 */
export function normalizeAddress(email: string): string {
  const lower = email.toLowerCase();
  const [localPart, domain] = lower.split("@");
  if (!domain) return lower; // Invalid email, return as-is

  // Strip dots from local-part
  const normalizedLocal = localPart.replace(/\./g, "");

  // Strip + aliases (everything after +)
  const plusIndex = normalizedLocal.indexOf("+");
  const finalLocal = plusIndex >= 0 ? normalizedLocal.slice(0, plusIndex) : normalizedLocal;

  return `${finalLocal}@${domain}`;
}

/**
 * Extract the normalized local-part from an email address.
 * Useful for clustering addresses that share the same local-part across different domains.
 */
export function normalizedLocalPart(email: string): string {
  const normalized = normalizeAddress(email);
  return normalized.split("@")[0];
}
