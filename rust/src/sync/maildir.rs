//! Write `.eml` + `.meta.json` under maildir (mirrors TS sync path).

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct MetaSidecar {
    pub labels: Vec<String>,
}

pub struct MaildirWrite {
    pub eml_path: PathBuf,
    pub meta_path: PathBuf,
    pub relative_raw_path: String,
}

/// Write `cur/<base>.eml` and `cur/<base>.meta.json`. Returns paths and DB `raw_path` fragment.
pub fn write_maildir_message(
    maildir_cur: &Path,
    basename: &str,
    raw_eml: &[u8],
    labels: &[String],
) -> std::io::Result<MaildirWrite> {
    fs::create_dir_all(maildir_cur)?;
    let eml_path = maildir_cur.join(format!("{basename}.eml"));
    let meta_path = maildir_cur.join(format!("{basename}.meta.json"));
    fs::write(&eml_path, raw_eml)?;
    let meta = MetaSidecar {
        labels: labels.to_vec(),
    };
    fs::write(
        &meta_path,
        serde_json::to_string_pretty(&meta).unwrap_or_else(|_| "{}".into()),
    )?;
    let relative_raw_path = format!("maildir/cur/{basename}.eml");
    Ok(MaildirWrite {
        eml_path,
        meta_path,
        relative_raw_path,
    })
}
