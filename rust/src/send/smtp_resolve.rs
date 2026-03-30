//! Infer SMTP endpoint from IMAP host.

use crate::config::{resolve_smtp_settings, SmtpJson};

pub fn resolve_smtp_for_imap_host(
    imap_host: &str,
    overrides: Option<&SmtpJson>,
) -> Result<crate::config::ResolvedSmtp, String> {
    resolve_smtp_settings(imap_host, overrides)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gmail_defaults() {
        let r = resolve_smtp_for_imap_host("imap.gmail.com", None).unwrap();
        assert_eq!(r.host, "smtp.gmail.com");
        assert_eq!(r.port, 587);
        assert!(!r.secure);
    }

    #[test]
    fn generic_imap_subdomain() {
        let r = resolve_smtp_for_imap_host("imap.example.org", None).unwrap();
        assert_eq!(r.host, "smtp.example.org");
    }

    #[test]
    fn override_host_port_secure() {
        let j = SmtpJson {
            host: Some("smtp.custom".into()),
            port: Some(465),
            secure: Some(true),
        };
        let r = resolve_smtp_for_imap_host("imap.gmail.com", Some(&j)).unwrap();
        assert_eq!(r.host, "smtp.custom");
        assert_eq!(r.port, 465);
        assert!(r.secure);
    }
}
