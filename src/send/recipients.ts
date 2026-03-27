/**
 * Optional dev/test guard: when ZMAIL_SEND_TEST is set, only DEV_SEND_ALLOWLIST may receive mail.
 * Default (unset): no recipient restriction.
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

function isSendTestMode(env: NodeJS.ProcessEnv): boolean {
  return env.ZMAIL_SEND_TEST === "1" || env.ZMAIL_SEND_TEST === "true";
}

/**
 * When ZMAIL_SEND_TEST is set, throws if any recipient is not the dev allowlist.
 * When unset, allows any recipient.
 */
export function assertSendRecipientsAllowed(
  addresses: string[],
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!isSendTestMode(env)) {
    return;
  }
  const allowed = normalizeForCompare(DEV_SEND_ALLOWLIST);
  for (const addr of addresses) {
    if (!addr.trim()) continue;
    if (normalizeForCompare(addr) !== allowed) {
      throw new Error(
        `Send blocked: recipient "${addr}" is not allowed when ZMAIL_SEND_TEST is set. Only ${DEV_SEND_ALLOWLIST} is permitted, or unset ZMAIL_SEND_TEST to send to other addresses.`
      );
    }
  }
}
