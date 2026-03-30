//! Read raw `.eml` from disk (`zmail read`).

use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub fn resolve_raw_path(raw_path: &str, data_dir: &Path) -> PathBuf {
    let p = Path::new(raw_path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        data_dir.join(raw_path)
    }
}

pub fn read_message_bytes(
    conn: &Connection,
    message_id: &str,
    data_dir: &Path,
) -> rusqlite::Result<std::io::Result<Vec<u8>>> {
    let raw: String = conn.query_row(
        "SELECT raw_path FROM messages WHERE message_id = ?1",
        [message_id],
        |r| r.get(0),
    )?;
    let path = resolve_raw_path(&raw, data_dir);
    Ok(std::fs::read(path))
}
