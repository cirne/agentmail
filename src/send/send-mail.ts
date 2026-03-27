import { randomUUID } from "crypto";
import { simpleParser } from "mailparser";
import type { AddressObject } from "mailparser";
import { loadConfig } from "~/lib/config";
import type { SqliteDatabase } from "~/db";
import { assertSendRecipientsAllowed } from "./recipients";
import { createSmtpTransport } from "./transport";
import { loadThreadingFromSourceMessage } from "./threading";
import { readDraft } from "./draft-store";

export interface SendSimpleFields {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
}

export interface SendResult {
  ok: boolean;
  messageId: string;
  smtpResponse?: string;
  dryRun?: boolean;
}

function flattenAddresses(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  const blocks = Array.isArray(field) ? field : [field];
  const out: string[] = [];
  for (const block of blocks) {
    for (const v of block.value) {
      if (v.address) out.push(v.address);
    }
  }
  return out;
}

function generateOutboundMessageId(fromEmail: string): string {
  const domain = fromEmail.includes("@") ? fromEmail.split("@")[1] : "localhost";
  return `<zmail-${randomUUID()}@${domain}>`;
}

/**
 * Send a plain-text message via SMTP (Phase 1-style fields).
 */
export async function sendSimpleMessage(
  fields: SendSimpleFields,
  options: {
    dryRun?: boolean;
    env?: NodeJS.ProcessEnv;
    db?: SqliteDatabase;
    maildirPath?: string;
  } = {}
): Promise<SendResult> {
  const cfg = loadConfig({ env: options.env });
  if (!cfg.imap.user?.trim()) {
    throw new Error("Missing imap.user in config");
  }
  if (!cfg.imap.password) {
    throw new Error("Missing ZMAIL_IMAP_PASSWORD / imap.password");
  }

  const recipients = [...fields.to, ...(fields.cc ?? []), ...(fields.bcc ?? [])];
  assertSendRecipientsAllowed(recipients, options.env);

  const from = cfg.imap.user.trim();
  const messageId = generateOutboundMessageId(from);

  const transport = createSmtpTransport(cfg.smtp, {
    user: cfg.imap.user,
    pass: cfg.imap.password,
  });

  const headers: Record<string, string> = {};
  if (fields.inReplyTo) headers["In-Reply-To"] = fields.inReplyTo;
  if (fields.references) headers.References = fields.references;

  const mailOptions: Parameters<typeof transport.sendMail>[0] = {
    from,
    to: fields.to.join(", "),
    cc: fields.cc?.length ? fields.cc.join(", ") : undefined,
    bcc: fields.bcc?.length ? fields.bcc.join(", ") : undefined,
    subject: fields.subject,
    text: fields.text,
    messageId,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };

  if (options.dryRun) {
    return { ok: true, messageId, dryRun: true };
  }

  const info = await transport.sendMail(mailOptions);
  return {
    ok: true,
    messageId,
    smtpResponse: info.response as string | undefined,
  };
}

/**
 * Parse raw RFC 822 and send (Phase 1). Recipients taken from To/Cc/Bcc for allowlist.
 */
export async function sendRawRfc822(
  raw: string | Buffer,
  options: { dryRun?: boolean; env?: NodeJS.ProcessEnv } = {}
): Promise<SendResult> {
  const parsed = await simpleParser(raw);
  const cfg = loadConfig({ env: options.env });
  if (!cfg.imap.user?.trim() || !cfg.imap.password) {
    throw new Error("Missing IMAP user/password for SMTP");
  }

  const toList = flattenAddresses(parsed.to);
  const ccList = flattenAddresses(parsed.cc);
  const bccList = flattenAddresses(parsed.bcc);

  const all = [...toList, ...ccList, ...bccList];
  assertSendRecipientsAllowed(all, options.env);

  const from = cfg.imap.user.trim();
  const messageId = parsed.messageId
    ? parsed.messageId.startsWith("<")
      ? parsed.messageId
      : `<${parsed.messageId}>`
    : generateOutboundMessageId(from);

  const transport = createSmtpTransport(cfg.smtp, {
    user: cfg.imap.user,
    pass: cfg.imap.password,
  });

  if (options.dryRun) {
    return { ok: true, messageId, dryRun: true };
  }

  if (toList.length === 0) {
    throw new Error("Raw message has no To: recipients");
  }

  const text = parsed.text ?? "";
  const html = typeof parsed.html === "string" ? parsed.html : undefined;

  const info = await transport.sendMail({
    from,
    to: toList.join(", "),
    cc: ccList?.length ? ccList.join(", ") : undefined,
    bcc: bccList?.length ? bccList.join(", ") : undefined,
    subject: parsed.subject ?? "",
    text,
    html,
    messageId,
    headers: parsed.inReplyTo
      ? {
          "In-Reply-To": parsed.inReplyTo,
          ...(parsed.references ? { References: String(parsed.references) } : {}),
        }
      : undefined,
  });

  return {
    ok: true,
    messageId,
    smtpResponse: info.response as string | undefined,
  };
}

/**
 * Send a stored draft (loads threading when sourceMessageId is set).
 */
export async function sendDraftById(
  draftId: string,
  options: {
    dryRun?: boolean;
    env?: NodeJS.ProcessEnv;
    db: SqliteDatabase;
    dataDir: string;
    maildirPath: string;
  }
): Promise<SendResult> {
  const draft = readDraft(options.dataDir, draftId);
  const fm = draft.frontmatter;
  const to = fm.to ?? [];
  if (to.length === 0) {
    throw new Error("Draft has no recipients (to:)");
  }

  let inReplyTo = fm.inReplyTo;
  let references = fm.references;

  if (fm.kind === "reply" && fm.sourceMessageId && options.db) {
    const threading = await loadThreadingFromSourceMessage(
      options.db,
      options.maildirPath,
      fm.sourceMessageId
    );
    inReplyTo = threading.inReplyTo;
    references = threading.references;
  }

  return sendSimpleMessage(
    {
      to,
      cc: fm.cc,
      bcc: fm.bcc,
      subject: fm.subject ?? "(no subject)",
      text: draft.body,
      inReplyTo,
      references,
    },
    { dryRun: options.dryRun, env: options.env, db: options.db, maildirPath: options.maildirPath }
  );
}
