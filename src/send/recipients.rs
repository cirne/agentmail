//! `ZMAIL_SEND_TEST` recipient allowlist.

/// When `ZMAIL_SEND_TEST=1`, only this address may receive mail (mirrors `recipients.ts`).
pub const DEV_SEND_ALLOWLIST: &str = "lewiscirne+zmail@gmail.com";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendTestMode {
    Off,
    On,
}

pub fn parse_send_test_mode() -> SendTestMode {
    match std::env::var("ZMAIL_SEND_TEST") {
        Ok(v) if v == "1" || v.eq_ignore_ascii_case("true") => SendTestMode::On,
        _ => SendTestMode::Off,
    }
}

/// Extract bare email from `Name <addr@x>` or `addr@x`.
pub fn extract_email_address(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(start) = trimmed.find('<') {
        if let Some(end) = trimmed.rfind('>') {
            if end > start {
                return trimmed[start + 1..end].trim().to_string();
            }
        }
    }
    trimmed.to_string()
}

fn normalize_for_compare(addr: &str) -> String {
    extract_email_address(addr).to_lowercase()
}

/// When `ZMAIL_SEND_TEST` is set, returns Err unless every recipient matches [`DEV_SEND_ALLOWLIST`].
pub fn assert_send_recipients_allowed(recipients: &[String]) -> Result<(), String> {
    if parse_send_test_mode() == SendTestMode::Off {
        return Ok(());
    }
    let allowed = normalize_for_compare(DEV_SEND_ALLOWLIST);
    for addr in recipients {
        if addr.trim().is_empty() {
            continue;
        }
        if normalize_for_compare(addr) != allowed {
            return Err(format!(
                "Send blocked: recipient \"{addr}\" is not allowed when ZMAIL_SEND_TEST is set. Only {DEV_SEND_ALLOWLIST} is permitted, or unset ZMAIL_SEND_TEST to send to other addresses."
            ));
        }
    }
    Ok(())
}

/// Split comma/semicolon-separated addresses (shell `zmail send --to` style).
pub fn split_address_list(s: &str) -> Vec<String> {
    s.split([',', ';'])
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

/// When send-test is on, only these addresses are allowed (mirrors TS allowlist shape).
pub fn filter_recipients_send_test(
    mode: SendTestMode,
    recipients: &[String],
    allowlist: &[String],
) -> Result<Vec<String>, String> {
    if mode == SendTestMode::Off {
        return Ok(recipients.to_vec());
    }
    let allow: std::collections::HashSet<String> =
        allowlist.iter().map(|s| s.to_lowercase()).collect();
    let mut out = Vec::new();
    for r in recipients {
        let l = r.to_lowercase();
        if allow.contains(&l) {
            out.push(r.clone());
        } else {
            return Err(format!(
                "ZMAIL_SEND_TEST=1: recipient {r} is not in the allowlist"
            ));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_test_off_passes_through() {
        let r = vec!["a@b.com".into(), "c@d.com".into()];
        let out = filter_recipients_send_test(SendTestMode::Off, &r, &[]).unwrap();
        assert_eq!(out, r);
    }

    #[test]
    fn send_test_on_allowlist() {
        let allow = vec!["a@b.com".into()];
        let out = filter_recipients_send_test(SendTestMode::On, &[String::from("A@B.com")], &allow)
            .unwrap();
        assert_eq!(out, vec!["A@B.com"]);
    }

    #[test]
    fn send_test_on_rejects() {
        let e = filter_recipients_send_test(
            SendTestMode::On,
            &[String::from("bad@x.com")],
            &[String::from("a@b.com")],
        )
        .unwrap_err();
        assert!(e.contains("allowlist"));
    }
}
