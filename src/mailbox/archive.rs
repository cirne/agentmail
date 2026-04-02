//! Best-effort IMAP archive when `mailboxManagement` is enabled.

use imap::Session;
use rusqlite::Connection;

use crate::config::Config;
use crate::sync::transport::connect_imap_session;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProviderArchiveOutcome {
    #[serde(rename = "attempted")]
    pub attempted: bool,
    #[serde(rename = "ok")]
    pub ok: bool,
    #[serde(rename = "error")]
    pub error: Option<String>,
}

/// If mailbox management allows archive, connect and move the message to a common archive folder.
/// Gmail: try `[Gmail]/All Mail` as destination (removes from Inbox when synced as All Mail).
/// Otherwise: try `Archive`, `[Gmail]/Archive`.
pub fn provider_archive_message(
    cfg: &Config,
    conn: &Connection,
    message_id: &str,
    unarchive: bool,
) -> ProviderArchiveOutcome {
    if !cfg.mailbox_management_enabled || !cfg.mailbox_management_allow_archive {
        return ProviderArchiveOutcome {
            attempted: false,
            ok: false,
            error: None,
        };
    }

    if unarchive {
        return ProviderArchiveOutcome {
            attempted: false,
            ok: false,
            error: Some("Provider unarchive is not implemented".into()),
        };
    }

    if cfg.imap_password.trim().is_empty() || cfg.imap_user.trim().is_empty() {
        return ProviderArchiveOutcome {
            attempted: true,
            ok: false,
            error: Some("Missing IMAP credentials".into()),
        };
    }

    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT folder, uid FROM messages WHERE message_id = ?1",
            [message_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let Some((folder, uid)) = row else {
        return ProviderArchiveOutcome {
            attempted: true,
            ok: false,
            error: Some("Message not found in index".into()),
        };
    };

    let mut session = match connect_imap_session(
        &cfg.imap_host,
        cfg.imap_port,
        &cfg.imap_user,
        &cfg.imap_password,
    ) {
        Ok(s) => s,
        Err(e) => {
            return ProviderArchiveOutcome {
                attempted: true,
                ok: false,
                error: Some(e.to_string()),
            };
        }
    };

    let dest_candidates = ["[Gmail]/All Mail", "Archive", "[Gmail]/Archive"];

    for dest in dest_candidates {
        if try_uid_move(&mut session, &folder, uid as u32, dest).is_ok() {
            let _ = session.logout();
            return ProviderArchiveOutcome {
                attempted: true,
                ok: true,
                error: None,
            };
        }
    }

    let _ = session.logout();
    ProviderArchiveOutcome {
        attempted: true,
        ok: false,
        error: Some(
            "Could not move message to a known archive folder (tried [Gmail]/All Mail, Archive)"
                .into(),
        ),
    }
}

fn try_uid_move(
    session: &mut Session<imap::Connection>,
    source_mailbox: &str,
    uid: u32,
    dest_mailbox: &str,
) -> Result<(), String> {
    session.select(source_mailbox).map_err(|e| e.to_string())?;
    let uid_s = uid.to_string();
    session
        .uid_mv(&uid_s, dest_mailbox)
        .map_err(|e| e.to_string())?;
    Ok(())
}
