//! Inbox notable-mail scan (`src/inbox/scan.ts`).

pub mod bootstrap;
pub mod scan;
pub mod state;

pub use bootstrap::{run_post_rebuild_inbox_bootstrap, PostRebuildBootstrapSummary};
pub use scan::{
    inbox_candidate_prefetch_limit, preview_rule_impact, run_inbox_scan, InboxBatchClassifier,
    InboxCandidate, InboxNotablePick, InboxOwnerContext, MockInboxClassifier,
    OpenAiInboxClassifier, RuleImpactPreview, RunInboxScanError, RunInboxScanOptions,
    RunInboxScanResult,
};
pub use state::{
    archive_messages_locally, bulk_archive_messages_older_than, clear_inbox_tables,
    load_cached_inbox_decisions, persist_inbox_decisions, record_inbox_scan, CachedInboxDecision,
    InboxSurfaceMode,
};
