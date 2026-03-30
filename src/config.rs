//! Configuration — mirrors `src/lib/config.ts` (without OpenAI getter side effects for tests).

use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigJson {
    pub imap: Option<ImapJson>,
    pub smtp: Option<SmtpJson>,
    pub sync: Option<SyncJson>,
    pub attachments: Option<AttachmentsJson>,
    pub inbox: Option<InboxJson>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapJson {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpJson {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub secure: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncJson {
    pub default_since: Option<String>,
    pub mailbox: Option<String>,
    pub exclude_labels: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentsJson {
    pub cache_extracted_text: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxJson {
    pub default_window: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedSmtp {
    pub host: String,
    pub port: u16,
    pub secure: bool,
}

/// Infer SMTP from IMAP host (see `src/send/smtp-resolve.ts`).
pub fn resolve_smtp_settings(
    imap_host: &str,
    overrides: Option<&SmtpJson>,
) -> Result<ResolvedSmtp, String> {
    let h = imap_host.trim().to_lowercase();
    let base: Option<ResolvedSmtp> = if h == "imap.gmail.com" {
        Some(ResolvedSmtp {
            host: "smtp.gmail.com".into(),
            port: 587,
            secure: false,
        })
    } else {
        h.strip_prefix("imap.").map(|rest| ResolvedSmtp {
            host: format!("smtp.{rest}"),
            port: 587,
            secure: false,
        })
    };

    let o = overrides;
    let base = match base {
        Some(b) => b,
        None => {
            if let Some(s) = o {
                if let (Some(host), Some(port), Some(secure)) = (&s.host, s.port, s.secure) {
                    return Ok(ResolvedSmtp {
                        host: host.clone(),
                        port,
                        secure,
                    });
                }
            }
            return Err(format!(
                "Cannot infer SMTP settings for IMAP host \"{imap_host}\". Set smtp.host, smtp.port, and smtp.secure in config.json."
            ));
        }
    };

    Ok(ResolvedSmtp {
        host: o.and_then(|x| x.host.clone()).unwrap_or(base.host),
        port: o.and_then(|x| x.port).unwrap_or(base.port),
        secure: o.and_then(|x| x.secure).unwrap_or(base.secure),
    })
}

fn load_env_file(home: &Path) -> HashMap<String, String> {
    let path = home.join(".env");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    let mut map = HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once('=') {
            let key = k.trim();
            if matches!(
                key,
                "ZMAIL_EMAIL" | "ZMAIL_IMAP_PASSWORD" | "ZMAIL_OPENAI_API_KEY" | "OPENAI_API_KEY"
            ) {
                map.insert(key.to_string(), v.to_string());
            }
        }
    }
    map
}

fn load_config_json(home: &Path) -> ConfigJson {
    let path = home.join("config.json");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return ConfigJson::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

/// Resolved configuration (pure: no global env mutation).
#[derive(Debug, Clone)]
pub struct Config {
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_user: String,
    pub imap_password: String,
    pub smtp: ResolvedSmtp,
    pub sync_default_since: String,
    pub sync_mailbox: String,
    pub sync_exclude_labels: Vec<String>,
    pub attachments_cache_extracted_text: bool,
    pub inbox_default_window: String,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub maildir_path: PathBuf,
}

impl Config {
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn maildir_path(&self) -> &Path {
        &self.maildir_path
    }
}

pub struct LoadConfigOptions {
    pub home: Option<PathBuf>,
    /// If None, reads `std::env::vars()` into a map for known keys only.
    pub env: Option<HashMap<String, String>>,
}

fn zmail_home(explicit: Option<PathBuf>) -> PathBuf {
    explicit.unwrap_or_else(|| {
        std::env::var("ZMAIL_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".zmail")
            })
    })
}

fn effective_env(
    key: &str,
    env_file: &HashMap<String, String>,
    process: &HashMap<String, String>,
) -> Option<String> {
    process
        .get(key)
        .cloned()
        .or_else(|| env_file.get(key).cloned())
}

/// Load config like TS `loadConfig(options?)`.
pub fn load_config(opts: LoadConfigOptions) -> Config {
    let home = zmail_home(opts.home);
    let env_file = load_env_file(&home);
    let json = load_config_json(&home);

    let process_env: HashMap<String, String> =
        opts.env.unwrap_or_else(|| std::env::vars().collect());

    let imap_host = json
        .imap
        .as_ref()
        .and_then(|i| i.host.clone())
        .unwrap_or_else(|| "imap.gmail.com".into());

    let smtp = resolve_smtp_settings(&imap_host, json.smtp.as_ref())
        .expect("SMTP resolution: default imap.gmail.com always resolves");

    let imap_user = json
        .imap
        .as_ref()
        .and_then(|i| i.user.clone())
        .or_else(|| effective_env("ZMAIL_EMAIL", &env_file, &process_env))
        .unwrap_or_default();

    let imap_password =
        effective_env("ZMAIL_IMAP_PASSWORD", &env_file, &process_env).unwrap_or_default();

    let data_dir = home.join("data");
    let db_path = data_dir.join("zmail.db");
    let maildir_path = data_dir.join("maildir");

    Config {
        imap_host,
        imap_port: json.imap.as_ref().and_then(|i| i.port).unwrap_or(993),
        imap_user,
        imap_password,
        smtp,
        sync_default_since: json
            .sync
            .as_ref()
            .and_then(|s| s.default_since.clone())
            .unwrap_or_else(|| "1y".into()),
        sync_mailbox: json
            .sync
            .as_ref()
            .and_then(|s| s.mailbox.clone())
            .unwrap_or_default(),
        sync_exclude_labels: json
            .sync
            .as_ref()
            .and_then(|s| s.exclude_labels.clone())
            .unwrap_or_else(|| vec!["trash".into(), "spam".into()]),
        attachments_cache_extracted_text: json
            .attachments
            .as_ref()
            .and_then(|a| a.cache_extracted_text)
            .unwrap_or(false),
        inbox_default_window: json
            .inbox
            .as_ref()
            .and_then(|i| i.default_window.clone())
            .unwrap_or_else(|| "24h".into()),
        data_dir,
        db_path,
        maildir_path,
    }
}

/// Resolve OpenAI API key from process env and `~/.zmail/.env` (same keys as Node `config.openai`).
pub fn resolve_openai_api_key(opts: &LoadConfigOptions) -> Option<String> {
    let home = zmail_home(opts.home.clone());
    let env_file = load_env_file(&home);
    let process_env: HashMap<String, String> = opts
        .env
        .clone()
        .unwrap_or_else(|| std::env::vars().collect());
    effective_env("ZMAIL_OPENAI_API_KEY", &env_file, &process_env)
        .filter(|s: &String| !s.trim().is_empty())
        .or_else(|| {
            effective_env("OPENAI_API_KEY", &env_file, &process_env)
                .filter(|s: &String| !s.trim().is_empty())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_smtp_unknown_host_errors() {
        let r = resolve_smtp_settings("mail.example.com", None);
        assert!(r.is_err());
    }

    #[test]
    fn resolve_smtp_override_only_when_complete() {
        let j = SmtpJson {
            host: Some("mx.example.com".into()),
            port: Some(587),
            secure: Some(false),
        };
        let r = resolve_smtp_settings("unknown.imap.com", Some(&j)).unwrap();
        assert_eq!(r.host, "mx.example.com");
    }

    #[test]
    fn config_json_empty_object() {
        let j: ConfigJson = serde_json::from_str("{}").unwrap();
        assert!(j.imap.is_none());
    }

    #[test]
    fn config_json_deserialize_nested() {
        let raw = r#"{"imap":{"host":"imap.x","port":993,"user":"u@x.com"},"inbox":{"defaultWindow":"48h"}}"#;
        let j: ConfigJson = serde_json::from_str(raw).unwrap();
        assert_eq!(j.imap.as_ref().unwrap().host.as_deref(), Some("imap.x"));
        assert_eq!(
            j.inbox.as_ref().unwrap().default_window.as_deref(),
            Some("48h")
        );
    }
}
