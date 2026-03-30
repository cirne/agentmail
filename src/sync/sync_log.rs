//! Append-only sync file logger (`ZMAIL_HOME/logs/sync.log` — mirrors Node `SYNC_LOG_PATH`).

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Fixed path segment under `ZMAIL_HOME`.
pub fn sync_log_path(zmail_home: &Path) -> PathBuf {
    zmail_home.join("logs").join("sync.log")
}

pub struct SyncFileLogger {
    path: PathBuf,
    file: Mutex<std::fs::File>,
}

impl SyncFileLogger {
    pub fn open(zmail_home: &Path) -> std::io::Result<Self> {
        let dir = zmail_home.join("logs");
        create_dir_all(&dir)?;
        let path = dir.join("sync.log");
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            path,
            file: Mutex::new(file),
        })
    }

    pub fn log_path(&self) -> &Path {
        &self.path
    }

    pub fn write_separator(&self, pid: u32) {
        let line = format!(
            "\n{} ===== zmail sync run pid={} =====\n",
            chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ"),
            pid
        );
        let _ = self.write_line(&line);
    }

    pub fn info(&self, msg: &str, data: Option<&str>) {
        self.log("INFO", msg, data);
    }

    pub fn warn(&self, msg: &str, data: Option<&str>) {
        self.log("WARN", msg, data);
    }

    pub fn error(&self, msg: &str, data: Option<&str>) {
        self.log("ERROR", msg, data);
    }

    fn log(&self, level: &str, msg: &str, data: Option<&str>) {
        let ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ");
        let line = match data {
            Some(d) => format!("[{ts}] {level} {msg} {d}\n"),
            None => format!("[{ts}] {level} {msg}\n"),
        };
        let _ = self.write_line(&line);
    }

    fn write_line(&self, line: &str) -> std::io::Result<()> {
        let mut f = self
            .file
            .lock()
            .map_err(|e| std::io::Error::other(format!("log mutex: {e}")))?;
        f.write_all(line.as_bytes())?;
        f.flush()?;
        Ok(())
    }
}
