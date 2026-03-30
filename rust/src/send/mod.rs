//! Outbound mail — drafts, SMTP resolve, threading (`src/send` subset).

pub mod draft_store;
pub mod recipients;
pub mod smtp_resolve;
pub mod threading;

pub use draft_store::{
    list_drafts, read_draft, write_draft, DraftFile, DraftListFull, DraftListSlim, DraftMeta,
};
pub use recipients::{filter_recipients_send_test, SendTestMode};
pub use smtp_resolve::resolve_smtp_for_imap_host;
pub use threading::extract_threading_headers;

#[derive(Debug, Clone, Default)]
pub struct SendPlan {
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
    pub dry_run: bool,
}

/// Build outbound plan without opening SMTP when `dry_run` is set.
pub fn plan_send(plan: &SendPlan) -> Result<(), String> {
    if plan.dry_run {
        return Ok(());
    }
    Err("SMTP send not implemented in this build (use dry_run)".into())
}
