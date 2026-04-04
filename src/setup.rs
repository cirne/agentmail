//! Non-interactive `zmail setup` and shared helpers for `zmail wizard` / validation.

use serde::Serialize;
use serde_json::json;
use std::fs;
use std::io;
use std::path::Path;

use crate::config::ConfigJson;
use crate::sync::connect_imap_session;

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

/// Resolved IMAP endpoint from a known email provider (mirrors Node `deriveImapSettings`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedImap {
    pub host: String,
    pub port: u16,
}

/// Derive IMAP host/port from email domain. Returns `None` if unknown (caller prompts host/port).
pub fn derive_imap_settings(email: &str) -> Option<DerivedImap> {
    let domain = email.split('@').nth(1)?.trim().to_lowercase();
    if domain == "gmail.com" {
        Some(DerivedImap {
            host: "imap.gmail.com".into(),
            port: 993,
        })
    } else {
        None
    }
}

/// Partial state from existing `config.json` (wizard defaults).
#[derive(Debug, Default, Clone)]
pub struct ExistingWizardConfig {
    pub email: Option<String>,
    pub imap_host: Option<String>,
    pub imap_port: Option<u16>,
    pub default_since: Option<String>,
}

/// Secrets from existing `~/.zmail/.env` (wizard reuse prompts).
#[derive(Debug, Default, Clone)]
pub struct ExistingEnvSecrets {
    pub password: Option<String>,
    pub api_key: Option<String>,
}

pub fn load_existing_wizard_config(home: &Path) -> ExistingWizardConfig {
    let path = home.join("config.json");
    let Ok(content) = fs::read_to_string(&path) else {
        return ExistingWizardConfig::default();
    };
    let j: ConfigJson = serde_json::from_str(&content).unwrap_or_default();
    ExistingWizardConfig {
        email: j.imap.as_ref().and_then(|i| i.user.clone()),
        imap_host: j.imap.as_ref().and_then(|i| i.host.clone()),
        imap_port: j.imap.as_ref().and_then(|i| i.port),
        default_since: j.sync.as_ref().and_then(|s| s.default_since.clone()),
    }
}

/// Load secrets from `.env` under `home` (same keys as Node `loadExistingEnv`).
pub fn load_existing_env_secrets(home: &Path) -> ExistingEnvSecrets {
    let path = home.join(".env");
    let Ok(content) = fs::read_to_string(&path) else {
        return ExistingEnvSecrets::default();
    };
    parse_dotenv_secrets(&content)
}

/// Parse `ZMAIL_IMAP_PASSWORD` and `ZMAIL_OPENAI_API_KEY` from dotenv-style text (for tests).
pub fn parse_dotenv_secrets(content: &str) -> ExistingEnvSecrets {
    let mut password = None;
    let mut api_key = None;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once('=') {
            match k.trim() {
                "ZMAIL_IMAP_PASSWORD" => password = Some(v.to_string()),
                "ZMAIL_OPENAI_API_KEY" | "OPENAI_API_KEY" => api_key = Some(v.to_string()),
                _ => {}
            }
        }
    }
    ExistingEnvSecrets { password, api_key }
}

/// Mask a secret for display (Node `maskSecret`).
pub fn mask_secret(value: &str) -> String {
    if value.len() <= 4 {
        "****".to_string()
    } else {
        format!("{}...", &value[..4])
    }
}

/// Parameters for writing `config.json` + `.env` (Node wizard / non-interactive shape).
pub struct WriteZmailParams<'a> {
    pub home: &'a Path,
    pub email: &'a str,
    pub password: &'a str,
    pub openai_key: Option<&'a str>,
    pub imap_host: &'a str,
    pub imap_port: u16,
    pub default_since: &'a str,
}

/// Write `config.json` + `.env` under `home` (creates dirs). Matches Node `imap` + `sync` blocks.
pub fn write_zmail_config_and_env(p: &WriteZmailParams<'_>) -> io::Result<()> {
    fs::create_dir_all(p.home)?;
    let cfg = json!({
        "imap": {
            "host": p.imap_host,
            "port": p.imap_port,
            "user": p.email,
        },
        "sync": {
            "defaultSince": p.default_since,
            "mailbox": "",
            "excludeLabels": ["Trash", "Spam"],
        },
    });
    fs::write(
        p.home.join("config.json"),
        serde_json::to_string_pretty(&cfg)? + "\n",
    )?;

    let mut dotenv = format!("ZMAIL_IMAP_PASSWORD={}\n", p.password);
    if let Some(k) = p.openai_key.filter(|s| !s.is_empty()) {
        dotenv.push_str(&format!("ZMAIL_OPENAI_API_KEY={k}\n"));
    }
    fs::write(p.home.join(".env"), dotenv)?;
    crate::rules::ensure_default_rules_file(p.home).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(())
}

/// Write `config.json` + `.env` for non-interactive `zmail setup` (derives host/port from Gmail).
pub fn write_setup(
    home: &Path,
    email: &str,
    password: &str,
    openai_key: Option<&str>,
) -> io::Result<()> {
    let (host, port) = match derive_imap_settings(email) {
        Some(d) => (d.host, d.port),
        None => ("imap.gmail.com".into(), 993),
    };
    write_zmail_config_and_env(&WriteZmailParams {
        home,
        email,
        password,
        openai_key,
        imap_host: &host,
        imap_port: port,
        default_since: "1y",
    })
}

/// Remove `config.json`, `.env`, and `data/` under `home` (wizard `--clean`).
pub fn clean_zmail_home(home: &Path) -> io::Result<()> {
    for name in ["config.json", ".env"] {
        let path = home.join(name);
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    let data = home.join("data");
    if data.exists() {
        fs::remove_dir_all(&data)?;
    }
    Ok(())
}

/// Validate IMAP by connecting and logging out (Node `validateImap`).
pub fn validate_imap_credentials(
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
) -> Result<(), String> {
    let mut s = connect_imap_session(host, port, user, pass).map_err(|e| e.to_string())?;
    s.logout().map_err(|e| e.to_string())?;
    Ok(())
}

/// Validate OpenAI key via `models.list` (Node `validateOpenAI`).
pub fn validate_openai_key(api_key: &str) -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(async {
        use async_openai::config::OpenAIConfig;
        use async_openai::Client;
        let client = Client::with_config(OpenAIConfig::new().with_api_key(api_key));
        client.models().list().await.map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_gmail() {
        let d = derive_imap_settings("a@gmail.com").unwrap();
        assert_eq!(d.host, "imap.gmail.com");
        assert_eq!(d.port, 993);
    }

    #[test]
    fn derive_unknown() {
        assert!(derive_imap_settings("a@corp.com").is_none());
    }

    #[test]
    fn mask_secret_short() {
        assert_eq!(mask_secret("ab"), "****");
    }

    #[test]
    fn mask_secret_long() {
        assert_eq!(mask_secret("sk-long-key"), "sk-l...");
    }

    #[test]
    fn parse_dotenv() {
        let s = parse_dotenv_secrets("ZMAIL_IMAP_PASSWORD=secret\nZMAIL_OPENAI_API_KEY=sk-test\n");
        assert_eq!(s.password.as_deref(), Some("secret"));
        assert_eq!(s.api_key.as_deref(), Some("sk-test"));
    }
}
