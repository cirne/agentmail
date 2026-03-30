//! IMAP sync: parsing, windows, maildir, locks, and `run_sync` / IMAP transport.

pub mod background_spawn;
pub mod error;
pub mod fetch_timeout;
pub mod imap_date;
pub mod maildir;
pub mod parse_message;
pub mod parse_since;
pub mod process_lock;
pub mod retry;
pub mod run;
pub mod sync_log;
pub mod transport;
pub mod windows;

pub use background_spawn::spawn_sync_background_detached;
pub use error::RunSyncError;
pub use maildir::{write_maildir_message, MaildirWrite};
pub use parse_message::{parse_raw_message, ParsedAttachment, ParsedMessage};
pub use parse_since::parse_since_to_date;
pub use process_lock::{
    acquire_lock, is_process_alive, is_sync_lock_held, release_lock, LockResult, SyncLockRow,
};
pub use run::{
    resolve_sync_mailbox, resolve_sync_since_ymd, run_sync, run_sync_with_parallel_imap_connect,
    should_early_exit_forward, SyncDirection, SyncOptions, SyncResult,
};
pub use sync_log::{sync_log_path, SyncFileLogger};
pub use transport::{
    connect_imap_session, FakeImapTransport, FetchedMessage, ImapStatusData, RealImapTransport,
    SyncImapTransport,
};
pub use windows::{
    filter_uids_after, forward_uid_range, last_uid_for_folder, oldest_message_date_for_folder,
    same_calendar_day,
};
