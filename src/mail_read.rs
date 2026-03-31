//! Read raw `.eml` from disk (`zmail read`).

use crate::ids::resolve_message_id_and_raw_path;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub fn resolve_raw_path(raw_path: &str, data_dir: &Path) -> PathBuf {
    let p = Path::new(raw_path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        let direct = data_dir.join(raw_path);
        if direct.exists() || raw_path.starts_with("maildir/") {
            return direct;
        }
        let compat = data_dir.join("maildir").join(raw_path);
        if compat.exists() {
            return compat;
        }
        direct
    }
}

pub fn read_message_bytes(
    conn: &Connection,
    message_id: &str,
    data_dir: &Path,
) -> rusqlite::Result<std::io::Result<Vec<u8>>> {
    let Some((_mid, raw)) = resolve_message_id_and_raw_path(conn, message_id)? else {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    };
    let path = resolve_raw_path(&raw, data_dir);
    Ok(std::fs::read(path))
}
