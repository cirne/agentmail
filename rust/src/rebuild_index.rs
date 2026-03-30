//! Maildir → SQLite reindex (`zmail rebuild-index`), parallel parse + single-writer inserts.

use rayon::prelude::*;
use rusqlite::Connection;
use std::fs;
use std::ops::Deref;
use std::path::{Path, PathBuf};

use crate::db::message_persist::persist_message;
use crate::sync::parse_raw_message;

const DEFAULT_MAILBOX: &str = "[Gmail]/All Mail";

fn collect_eml_paths(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "eml") {
                out.push(p);
            }
        }
    }
    walk(root, &mut out);
    out.sort();
    out
}

/// Clear indexed mail (keeps schema); then re-import every `.eml` under `maildir_root`.
pub fn rebuild_from_maildir(conn: &mut Connection, maildir_root: &Path) -> rusqlite::Result<usize> {
    conn.execute_batch("DELETE FROM attachments; DELETE FROM messages; DELETE FROM threads;")?;

    let paths = collect_eml_paths(maildir_root);
    let parsed: Vec<(PathBuf, Vec<u8>)> = paths
        .par_iter()
        .filter_map(|p| {
            let bytes = fs::read(p).ok()?;
            Some((p.clone(), bytes))
        })
        .collect();

    let mut n = 0usize;
    let tx = conn.transaction()?;
    for (i, (path, bytes)) in parsed.iter().enumerate() {
        let p = parse_raw_message(bytes);
        let raw_s = path.to_string_lossy();
        if persist_message(
            tx.deref(),
            &p,
            DEFAULT_MAILBOX,
            (i + 1) as i64,
            "[]",
            raw_s.as_ref(),
        )? {
            n += 1;
        }
    }
    tx.commit()?;
    Ok(n)
}

/// Same as [`rebuild_from_maildir`] but single-threaded parse (for tests).
pub fn rebuild_from_maildir_sequential(
    conn: &mut Connection,
    maildir_root: &Path,
) -> rusqlite::Result<usize> {
    conn.execute_batch("DELETE FROM attachments; DELETE FROM messages; DELETE FROM threads;")?;
    let paths = collect_eml_paths(maildir_root);
    let tx = conn.transaction()?;
    let mut n = 0usize;
    for (i, path) in paths.iter().enumerate() {
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        let p = parse_raw_message(&bytes);
        let raw_s = path.to_string_lossy();
        if persist_message(
            tx.deref(),
            &p,
            DEFAULT_MAILBOX,
            (i + 1) as i64,
            "[]",
            raw_s.as_ref(),
        )? {
            n += 1;
        }
    }
    tx.commit()?;
    Ok(n)
}
