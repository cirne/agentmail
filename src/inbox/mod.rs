//! Inbox notable-mail scan (`src/inbox/scan.ts`).

pub mod scan;
pub mod state;

pub use scan::{
    inbox_candidate_prefetch_limit, run_inbox_scan, InboxBatchClassifier, InboxCandidate,
    InboxNotablePick, InboxOwnerContext, MockInboxClassifier, OpenAiInboxClassifier,
    RunInboxScanError, RunInboxScanOptions, RunInboxScanResult,
};
pub use state::{
    dismiss_message, load_cached_inbox_decisions, mark_message_handled, persist_inbox_decisions,
    record_inbox_scan, CachedInboxDecision, InboxSurfaceMode,
};
