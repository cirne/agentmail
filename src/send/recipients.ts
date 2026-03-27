/**
 * Dev/test guard: only one recipient allowed unless ZMAIL_SEND_PRODUCTION is set.
 */

export const DEV_SEND_ALLOWLIST = "lewiscirne+zmail@gmail.com";

/** Extract bare email from "Name <addr@x>" or "addr@x". */
export function extractEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  const angle = trimmed.match(/<([^>]+)>/);
  if (angle) return angle[1].trim();
  return trimmed;
}

function normalizeForCompare(addr: string): string {
  return extractEmailAddress(addr).toLowerCase();
}

/**
 * Throws if any recipient is not the dev allowlist and production mode is off.
 */
export function assertSendRecipientsAllowed(
  addresses: string[],
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.ZMAIL_SEND_PRODUCTION === "1" || env.ZMAIL_SEND_PRODUCTION === "true") {
    return;
  }
  const allowed = normalizeForCompare(DEV_SEND_ALLOWLIST);
  for (const addr of addresses) {
    if (!addr.trim()) continue;
    if (normalizeForCompare(addr) !== allowed) {
      throw new Error(
        `Send blocked: recipient "${addr}" is not allowed in dev/test. Only ${DEV_SEND_ALLOWLIST} is permitted, or set ZMAIL_SEND_PRODUCTION=1 to send to other addresses.`
      );
    }
  }
}
