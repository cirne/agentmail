//! Sync / IMAP errors.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum RunSyncError {
    #[error("IMAP: {0}")]
    Imap(String),
    #[error("SQLite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Config(String),
    #[error("fetchAll timed out after retries")]
    FetchTimeout,
}
