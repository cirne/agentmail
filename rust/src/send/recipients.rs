//! `ZMAIL_SEND_TEST` recipient allowlist.

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
