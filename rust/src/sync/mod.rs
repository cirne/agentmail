//! IMAP sync — Phase 2: parsing, windows, maildir, locks (full IMAP loop expands later).

pub mod maildir;
pub mod parse_message;
pub mod parse_since;
pub mod process_lock;
pub mod windows;

pub use maildir::{write_maildir_message, MaildirWrite};
pub use parse_message::{parse_raw_message, ParsedAttachment, ParsedMessage};
pub use parse_since::parse_since_to_date;
pub use process_lock::{
    acquire_lock, is_process_alive, is_sync_lock_held, release_lock, LockResult, SyncLockRow,
};
pub use windows::{
    filter_uids_after, forward_uid_range, last_uid_for_folder, oldest_message_date_for_folder,
    same_calendar_day,
};
