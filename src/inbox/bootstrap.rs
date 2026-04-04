//! Post-rebuild inbox bootstrap ([OPP-036 archived](../../docs/opportunities/archive/OPP-036-inbox-triage-orthogonal-archive.md)): clean slate, age-based archive, classify recent mail, archive `ignore`.

use rusqlite::Connection;

use crate::config::Config;
use crate::inbox::rule_match::DeterministicInboxClassifier;
use crate::inbox::scan::{
    run_inbox_scan, InboxOwnerContext, RunInboxScanError, RunInboxScanOptions,
};
use crate::inbox::state::{bulk_archive_messages_older_than, clear_inbox_tables, InboxSurfaceMode};
use crate::inbox_window::parse_inbox_window_to_iso_cutoff;
use crate::rules::{load_rules_file, rules_fingerprint};

/// Summary printed after `rebuild-index` bootstrap.
#[derive(Debug, Clone, Default)]
pub struct PostRebuildBootstrapSummary {
    pub bulk_archived_older_than_cutoff: usize,
    pub inbox_candidates_classified: usize,
}

fn zmail_home_from_cfg(cfg: &Config) -> std::path::PathBuf {
    cfg.data_dir
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| cfg.data_dir.clone())
}

/// Clear inbox tables, archive mail older than the rolling window, classify unarchived mail and archive `ignore`.
pub async fn run_post_rebuild_inbox_bootstrap(
    conn: &Connection,
    cfg: &Config,
    bootstrap_window: &str,
    diagnostics: bool,
) -> Result<PostRebuildBootstrapSummary, RunInboxScanError> {
    let mut summary = PostRebuildBootstrapSummary::default();
    clear_inbox_tables(conn)?;
    let cutoff = parse_inbox_window_to_iso_cutoff(bootstrap_window)
        .map_err(RunInboxScanError::InvalidWindow)?;
    eprintln!(
        "Inbox bootstrap: bulk-archiving messages older than {} (cutoff {})…",
        bootstrap_window,
        cutoff.as_str()
    );
    summary.bulk_archived_older_than_cutoff =
        bulk_archive_messages_older_than(conn, cutoff.as_str())?;

    let home = zmail_home_from_cfg(cfg);
    let rules = load_rules_file(&home)?;
    let imap_user = cfg.imap_user.as_str();
    let owner = InboxOwnerContext::from_addresses(
        (!imap_user.is_empty()).then_some(imap_user),
        &cfg.imap_aliases,
    );
    let fp = rules_fingerprint(&rules);
    let mut classifier = DeterministicInboxClassifier::new(&rules)?;

    eprintln!("Inbox bootstrap: categorizing recent inbox (deterministic rules)…");

    let scan = run_inbox_scan(
        conn,
        &RunInboxScanOptions {
            surface_mode: InboxSurfaceMode::Review,
            cutoff_iso: "1970-01-01T00:00:00.000Z".into(),
            include_all: true,
            replay: true,
            reapply_llm: true,
            diagnostics,
            rules_fingerprint: Some(fp),
            owner_address: owner.primary_address.clone(),
            owner_aliases: owner.alias_addresses.clone(),
            candidate_cap: Some(500),
            notable_cap: Some(50),
            batch_size: Some(40),
        },
        &mut classifier,
    )
    .await?;
    summary.inbox_candidates_classified = scan.candidates_scanned;
    Ok(summary)
}
