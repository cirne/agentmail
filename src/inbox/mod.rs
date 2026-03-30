//! Inbox notable-mail scan (`src/inbox/scan.ts`).

pub mod scan;

pub use scan::{
    inbox_candidate_prefetch_limit, run_inbox_scan, InboxBatchClassifier, InboxCandidate,
    InboxNotablePick, MockInboxClassifier, OpenAiInboxClassifier, RunInboxScanError,
    RunInboxScanOptions, RunInboxScanResult,
};
