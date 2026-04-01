//! Maildir → SQLite reindex (`zmail rebuild-index`), parallel parse + single-writer inserts.

use rayon::prelude::*;
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::sync_channel;
use std::thread;
use std::time::{Duration, Instant};

use crate::db::message_persist::RebuildWriter;
use crate::sync::{parse_index_message, parse_raw_message, ParsedMessage};

const DEFAULT_MAILBOX: &str = "[Gmail]/All Mail";
const DEFAULT_QUEUE_MULTIPLIER: usize = 2;
const PROGRESS_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Debug)]
struct ParsedWork {
    ordinal: usize,
    path: PathBuf,
    parsed: Option<ParsedMessage>,
}

struct RebuildProgress {
    total: usize,
    last_reported_at: Instant,
}

impl RebuildProgress {
    fn new(total: usize) -> Self {
        let now = Instant::now();
        Self {
            total,
            last_reported_at: now,
        }
    }

    fn maybe_report(&mut self, completed: usize) {
        let now = Instant::now();
        if now.duration_since(self.last_reported_at) < PROGRESS_INTERVAL {
            return;
        }
        self.last_reported_at = now;
        self.print(completed);
    }

    fn print(&self, completed: usize) {
        let pct = if self.total == 0 {
            100.0
        } else {
            (completed as f64 / self.total as f64) * 100.0
        };
        eprintln!("{completed}/{} processed ({pct:.0}%)", self.total);
    }
}

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
    let paths = collect_eml_paths(maildir_root);
    let total_paths = paths.len();
    let worker_count = thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let queue_bound = worker_count.saturating_mul(DEFAULT_QUEUE_MULTIPLIER).max(1);
    let (tx_work, rx_work) = sync_channel(queue_bound);

    let mut n = 0usize;
    thread::scope(|scope| -> rusqlite::Result<()> {
        scope.spawn(move || {
            paths
                .into_par_iter()
                .enumerate()
                .for_each_with(tx_work, |sender, (ordinal, path)| {
                    let parsed = fs::read(&path)
                        .ok()
                        .map(|bytes| parse_index_message(&bytes));
                    let _ = sender.send(ParsedWork {
                        ordinal,
                        path,
                        parsed,
                    });
                });
        });

        let tx = conn.transaction()?;
        tx.execute_batch("DELETE FROM attachments; DELETE FROM messages; DELETE FROM threads;")?;
        let mut writer = RebuildWriter::new(&tx)?;
        let mut pending = BTreeMap::new();
        let mut next_expected = 0usize;
        let mut next_uid = 1i64;
        let mut progress = RebuildProgress::new(total_paths);

        for work in rx_work {
            pending.insert(work.ordinal, work);
            while let Some(work) = pending.remove(&next_expected) {
                if let Some(parsed) = work.parsed {
                    let raw_s = work.path.to_string_lossy();
                    if writer.persist_message(
                        &parsed,
                        DEFAULT_MAILBOX,
                        next_uid,
                        "[]",
                        raw_s.as_ref(),
                    )? {
                        n += 1;
                    }
                    next_uid += 1;
                }
                next_expected += 1;
                progress.maybe_report(next_expected);
            }
        }
        progress.print(next_expected);
        drop(writer);
        tx.commit()?;
        Ok(())
    })?;
    Ok(n)
}

/// Same as [`rebuild_from_maildir`] but single-threaded parse (for tests).
pub fn rebuild_from_maildir_sequential(
    conn: &mut Connection,
    maildir_root: &Path,
) -> rusqlite::Result<usize> {
    let paths = collect_eml_paths(maildir_root);
    let tx = conn.transaction()?;
    tx.execute_batch("DELETE FROM attachments; DELETE FROM messages; DELETE FROM threads;")?;
    let mut writer = RebuildWriter::new(&tx)?;
    let mut n = 0usize;
    let mut next_uid = 1i64;
    for path in &paths {
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        let p = parse_raw_message(&bytes);
        let raw_s = path.to_string_lossy();
        if writer.persist_message(&p, DEFAULT_MAILBOX, next_uid, "[]", raw_s.as_ref())? {
            n += 1;
        }
        next_uid += 1;
    }
    drop(writer);
    tx.commit()?;
    Ok(n)
}
