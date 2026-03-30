//! Infer SMTP endpoint from IMAP host.

use crate::config::{resolve_smtp_settings, SmtpJson};

pub fn resolve_smtp_for_imap_host(imap_host: &str, overrides: Option<&SmtpJson>) -> Result<crate::config::ResolvedSmtp, String> {
    resolve_smtp_settings(imap_host, overrides)
}
