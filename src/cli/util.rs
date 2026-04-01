use std::path::PathBuf;

use zmail::{load_config, Config, LoadConfigOptions};

pub(crate) fn load_cfg() -> Config {
    load_config(LoadConfigOptions {
        home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
        env: None,
    })
}

pub(crate) fn zmail_home_path() -> PathBuf {
    std::env::var("ZMAIL_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().expect("HOME").join(".zmail"))
}

pub(crate) fn format_attachment_size(n: i64) -> String {
    if n >= 1024 * 1024 {
        format!("{:.2} MB", n as f64 / (1024.0 * 1024.0))
    } else if n >= 1024 {
        format!("{:.2} KB", n as f64 / 1024.0)
    } else {
        format!("{n} B")
    }
}
