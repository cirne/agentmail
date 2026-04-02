//! Optional provider-side mailbox mutations (IMAP), gated by config.

mod archive;

pub use archive::{provider_archive_message, ProviderArchiveOutcome};
