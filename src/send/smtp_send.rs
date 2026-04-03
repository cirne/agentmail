//! SMTP send via lettre (mirrors Node `sendSimpleMessage` + transport).

use crate::config::{Config, ResolvedSmtp};
use crate::send::recipients::assert_send_recipients_allowed;
use lettre::message::header::ContentType;
use lettre::message::{Mailbox, Message, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{SmtpTransport, Transport};
use uuid::Uuid;

/// SMTP verify (Node nodemailer `transport.verify()`). Uses same resolution as send path.
pub fn verify_smtp_credentials(imap_host: &str, user: &str, pass: &str) -> Result<(), String> {
    let smtp = crate::config::resolve_smtp_settings(imap_host, None)?;
    let creds = Credentials::new(user.to_string(), pass.to_string());
    let transport = build_smtp_transport(&smtp, creds).map_err(|e| e.to_string())?;
    transport.test_connection().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct SendSimpleFields {
    pub to: Vec<String>,
    pub cc: Option<Vec<String>>,
    pub bcc: Option<Vec<String>>,
    pub subject: String,
    pub text: String,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub ok: bool,
    #[serde(serialize_with = "crate::ids::serialize_string_id_for_json")]
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub smtp_response: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

fn generate_outbound_message_id(from_email: &str) -> String {
    let domain = from_email.split('@').nth(1).unwrap_or("localhost").trim();
    format!("<zmail-{}@{}>", Uuid::new_v4(), domain)
}

fn parse_mailbox(addr: &str) -> Result<Mailbox, String> {
    let s = addr.trim();
    if s.is_empty() {
        return Err("empty address".into());
    }
    s.parse::<Mailbox>()
        .map_err(|e| format!("invalid address {addr:?}: {e}"))
}

fn build_smtp_transport(
    smtp: &ResolvedSmtp,
    creds: Credentials,
) -> Result<SmtpTransport, lettre::transport::smtp::Error> {
    let builder = if smtp.secure {
        SmtpTransport::relay(&smtp.host)?
    } else {
        SmtpTransport::starttls_relay(&smtp.host)?
    };
    Ok(builder.credentials(creds).port(smtp.port).build())
}

/// Send a plain-text message via SMTP (same credentials as IMAP).
pub fn send_simple_message(
    cfg: &Config,
    fields: &SendSimpleFields,
    dry_run: bool,
) -> Result<SendResult, String> {
    let mut all_recipients: Vec<String> = Vec::new();
    all_recipients.extend(fields.to.clone());
    if let Some(cc) = &fields.cc {
        all_recipients.extend(cc.clone());
    }
    if let Some(bcc) = &fields.bcc {
        all_recipients.extend(bcc.clone());
    }
    assert_send_recipients_allowed(&all_recipients)?;

    let user = cfg.imap_user.trim();
    if dry_run {
        let from_for_id = if user.is_empty() {
            "dry-run@localhost"
        } else {
            user
        };
        let outbound_id = generate_outbound_message_id(from_for_id);
        return Ok(SendResult {
            ok: true,
            message_id: outbound_id,
            smtp_response: None,
            dry_run: Some(true),
        });
    }

    if user.is_empty() {
        return Err("Missing imap.user in config".into());
    }
    if cfg.imap_password.is_empty() {
        return Err("Missing ZMAIL_IMAP_PASSWORD / imap.password".into());
    }

    let outbound_id = generate_outbound_message_id(user);

    let from_mb = parse_mailbox(user)?;
    let mut builder = Message::builder()
        .from(from_mb.clone())
        .message_id(Some(outbound_id.clone()));

    for t in &fields.to {
        builder = builder.to(parse_mailbox(t)?);
    }
    if let Some(cc) = &fields.cc {
        for a in cc {
            builder = builder.cc(parse_mailbox(a)?);
        }
    }
    if let Some(bcc) = &fields.bcc {
        for a in bcc {
            builder = builder.bcc(parse_mailbox(a)?);
        }
    }

    if let Some(ref irt) = fields.in_reply_to {
        let v = irt.trim();
        if !v.is_empty() {
            builder = builder.in_reply_to(v.to_string());
        }
    }
    if let Some(ref refs) = fields.references {
        let v = refs.trim();
        if !v.is_empty() {
            builder = builder.references(v.to_string());
        }
    }

    let body = SinglePart::builder()
        .header(ContentType::TEXT_PLAIN)
        .body(fields.text.clone());

    let email = builder
        .subject(&fields.subject)
        .singlepart(body)
        .map_err(|e| format!("message build: {e}"))?;

    let creds = Credentials::new(user.to_string(), cfg.imap_password.clone());
    let transport =
        build_smtp_transport(&cfg.smtp, creds).map_err(|e| format!("SMTP transport: {e}"))?;

    let response = transport
        .send(&email)
        .map_err(|e| format!("SMTP send: {e}"))?;

    Ok(SendResult {
        ok: true,
        message_id: outbound_id,
        smtp_response: Some(format!("{response:?}")),
        dry_run: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{resolve_smtp_settings, Config};

    fn test_config() -> Config {
        let smtp = resolve_smtp_settings("imap.gmail.com", None).unwrap();
        Config {
            imap_host: "imap.gmail.com".into(),
            imap_port: 993,
            imap_user: "a@b.com".into(),
            imap_aliases: vec![],
            imap_password: "secret".into(),
            smtp,
            sync_default_since: "1y".into(),
            sync_mailbox: String::new(),
            sync_exclude_labels: vec![],
            attachments_cache_extracted_text: false,
            inbox_default_window: "24h".into(),
            inbox_bootstrap_archive_older_than: "1d".into(),
            mailbox_management_enabled: false,
            mailbox_management_allow_archive: false,
            data_dir: std::path::PathBuf::from("/tmp"),
            db_path: std::path::PathBuf::from("/tmp/z.db"),
            maildir_path: std::path::PathBuf::from("/tmp/m"),
        }
    }

    #[test]
    fn dry_run_no_network() {
        let cfg = test_config();
        let r = send_simple_message(
            &cfg,
            &SendSimpleFields {
                to: vec!["x@y.com".into()],
                cc: None,
                bcc: None,
                subject: "s".into(),
                text: "t".into(),
                in_reply_to: None,
                references: None,
            },
            true,
        )
        .unwrap();
        assert!(r.ok);
        assert!(r.message_id.starts_with("<zmail-"));
        assert_eq!(r.dry_run, Some(true));
    }
}
