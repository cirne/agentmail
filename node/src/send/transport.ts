import nodemailer from "nodemailer";
import type { ResolvedSmtp } from "./smtp-resolve";

export function createSmtpTransport(
  smtp: ResolvedSmtp,
  auth: { user: string; pass: string }
): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth,
  });
}

export async function verifySmtpConnection(
  smtp: ResolvedSmtp,
  auth: { user: string; pass: string }
): Promise<void> {
  const transport = createSmtpTransport(smtp, auth);
  await transport.verify();
}
