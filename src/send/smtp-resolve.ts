/**
 * Infer SMTP submission settings from IMAP host with optional config.json overrides.
 */

export interface ResolvedSmtp {
  host: string;
  port: number;
  /** true = implicit TLS (typical 465); false = STARTTLS (typical 587) */
  secure: boolean;
}

export interface SmtpOverrides {
  host?: string;
  port?: number;
  secure?: boolean;
}

const KNOWN_IMAP_TO_SMTP: Record<string, ResolvedSmtp> = {
  "imap.gmail.com": { host: "smtp.gmail.com", port: 587, secure: false },
};

/**
 * Resolve SMTP host/port/TLS from IMAP host and optional overrides.
 */
export function resolveSmtpSettings(imapHost: string, overrides?: SmtpOverrides | null): ResolvedSmtp {
  const h = imapHost.trim().toLowerCase();
  let base: ResolvedSmtp | undefined = KNOWN_IMAP_TO_SMTP[h];

  if (!base) {
    if (h.startsWith("imap.")) {
      const rest = h.slice("imap.".length);
      base = { host: `smtp.${rest}`, port: 587, secure: false };
    }
  }

  if (!base) {
    if (overrides?.host != null && overrides.port != null && overrides.secure != null) {
      return { host: overrides.host, port: overrides.port, secure: overrides.secure };
    }
    throw new Error(
      `Cannot infer SMTP settings for IMAP host "${imapHost}". Set smtp.host, smtp.port, and smtp.secure in ~/.zmail/config.json.`
    );
  }

  return {
    host: overrides?.host ?? base.host,
    port: overrides?.port ?? base.port,
    secure: overrides?.secure ?? base.secure,
  };
}
