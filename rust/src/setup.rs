//! Non-interactive `zmail setup` (`src/cli/setup` parity, subset).

use serde::Serialize;
use serde_json::json;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct SetupArgs {
    pub email: Option<String>,
    pub password: Option<String>,
    pub openai_key: Option<String>,
    pub no_validate: bool,
}

/// Resolve credential from CLI arg or `process_env` map (ZMAIL_* keys).
pub fn resolve_setup_email(
    args: &SetupArgs,
    env: &std::collections::HashMap<String, String>,
) -> Option<String> {
    args.email
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| env.get("ZMAIL_EMAIL").cloned())
        .filter(|s| !s.trim().is_empty())
}

pub fn resolve_setup_password(
    args: &SetupArgs,
    env: &std::collections::HashMap<String, String>,
) -> Option<String> {
    args.password
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| env.get("ZMAIL_IMAP_PASSWORD").cloned())
        .filter(|s| !s.is_empty())
}

/// Write `config.json` + `.env` under `home` (creates dirs).
pub fn write_setup(
    home: &Path,
    email: &str,
    password: &str,
    openai_key: Option<&str>,
) -> std::io::Result<()> {
    fs::create_dir_all(home)?;
    let cfg = json!({
        "imap": {
            "host": "imap.gmail.com",
            "port": 993,
            "user": email,
        },
        "sync": { "defaultSince": "1y" },
        "inbox": { "defaultWindow": "24h" },
    });
    fs::write(
        home.join("config.json"),
        serde_json::to_string_pretty(&cfg)?,
    )?;

    let mut dotenv = format!("ZMAIL_IMAP_PASSWORD={password}\n");
    if let Some(k) = openai_key.filter(|s| !s.is_empty()) {
        dotenv.push_str(&format!("ZMAIL_OPENAI_API_KEY={k}\n"));
    }
    fs::write(home.join(".env"), dotenv)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsJson {
    pub message_count: i64,
    pub thread_count: i64,
    pub attachment_count: i64,
    pub people_count: i64,
}

pub fn collect_stats(conn: &rusqlite::Connection) -> rusqlite::Result<StatsJson> {
    let message_count: i64 = conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))?;
    let thread_count: i64 = conn.query_row("SELECT COUNT(*) FROM threads", [], |r| r.get(0))?;
    let attachment_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))?;
    let people_count: i64 = conn.query_row("SELECT COUNT(*) FROM people", [], |r| r.get(0))?;
    Ok(StatsJson {
        message_count,
        thread_count,
        attachment_count,
        people_count,
    })
}
