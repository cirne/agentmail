use regex::Regex;
use std::path::PathBuf;
use std::sync::OnceLock;

use crate::cli::args::{CheckArgs, ReviewArgs};
use crate::cli::util::zmail_home_path;
use crate::cli::CliResult;
use zmail::{
    build_check_json, build_review_json, connect_imap_session, db, inbox_json_hints,
    load_rules_file, parse_inbox_window_to_iso_cutoff, print_check_text, print_review_text,
    resolve_openai_api_key, resolve_sync_mailbox, resolve_sync_since_ymd, run_inbox_scan,
    InboxSurfaceMode, LoadConfigOptions, OpenAiInboxClassifier, RunInboxScanOptions, SyncDirection,
    SyncFileLogger, SyncOptions, SyncResult,
};

pub(crate) trait InboxCliArgs {
    fn surface_mode(&self) -> InboxSurfaceMode;
    fn window(&self) -> Option<String>;
    fn since(&self) -> Option<String>;
    fn refresh(&self) -> bool;
    fn replay(&self) -> bool;
    fn force(&self) -> bool;
    fn include_all(&self) -> bool;
    fn diagnostics(&self) -> bool;
    /// Full per-row fields (note, decisionSource, attachments, matchedRuleIds) for JSON output.
    fn inbox_json_full_detail(&self) -> bool;
    fn text(&self) -> bool;
    fn verbose(&self) -> bool {
        false
    }
    fn watch(&self) -> bool {
        false
    }
    fn watch_interval_seconds(&self) -> u64 {
        60
    }
    fn reclassify(&self) -> bool {
        false
    }
}

impl InboxCliArgs for CheckArgs {
    fn surface_mode(&self) -> InboxSurfaceMode {
        InboxSurfaceMode::Check
    }

    fn window(&self) -> Option<String> {
        self.window.clone()
    }

    fn since(&self) -> Option<String> {
        self.since.clone()
    }

    fn refresh(&self) -> bool {
        !self.no_update
    }

    fn replay(&self) -> bool {
        self.thorough || self.replay
    }

    fn force(&self) -> bool {
        self.thorough || self.force
    }

    fn include_all(&self) -> bool {
        self.thorough || self.include_all
    }

    fn diagnostics(&self) -> bool {
        self.diagnostics
    }

    fn inbox_json_full_detail(&self) -> bool {
        self.diagnostics
            || self.thorough
            || self.replay
            || self.include_all
            || self.reclassify
            || self.verbose
    }

    fn text(&self) -> bool {
        self.text
    }

    fn verbose(&self) -> bool {
        self.verbose
    }

    fn watch(&self) -> bool {
        self.watch
    }

    fn watch_interval_seconds(&self) -> u64 {
        self.watch_interval_seconds
    }

    fn reclassify(&self) -> bool {
        self.thorough || self.reclassify
    }
}

impl InboxCliArgs for ReviewArgs {
    fn surface_mode(&self) -> InboxSurfaceMode {
        InboxSurfaceMode::Review
    }

    fn window(&self) -> Option<String> {
        self.window.clone()
    }

    fn since(&self) -> Option<String> {
        self.since.clone()
    }

    fn refresh(&self) -> bool {
        false
    }

    fn replay(&self) -> bool {
        self.thorough || self.replay
    }

    fn force(&self) -> bool {
        false
    }

    fn include_all(&self) -> bool {
        // Review lists the full inbox window (all Gmail/label categories), not only primary-tab mail.
        true
    }

    fn diagnostics(&self) -> bool {
        self.diagnostics
    }

    fn inbox_json_full_detail(&self) -> bool {
        self.diagnostics || self.thorough || self.replay || self.include_all || self.reclassify
    }

    fn text(&self) -> bool {
        self.text
    }

    fn reclassify(&self) -> bool {
        self.thorough || self.reclassify
    }
}

/// Node `parseInboxCliArgs`: `--since` wins; else optional positional `^\d+[dhmwy]?$` only.
fn inbox_rolling_window_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^\d+[dhmwy]?$").expect("regex"))
}

fn resolve_inbox_window_spec(since: Option<String>, window: Option<String>) -> Option<String> {
    if let Some(s) = since {
        return Some(s);
    }
    window.filter(|w| inbox_rolling_window_re().is_match(w.trim()))
}

pub(crate) fn empty_sync_result() -> SyncResult {
    SyncResult {
        synced: 0,
        messages_fetched: 0,
        bytes_downloaded: 0,
        duration_ms: 0,
        bandwidth_bytes_per_sec: 0.0,
        messages_per_minute: 0.0,
        log_path: String::new(),
        early_exit: None,
        new_message_ids: None,
    }
}

pub(crate) fn print_sync_foreground_metrics(r: &SyncResult) {
    let sec = (r.duration_ms as f64) / 1000.0;
    let mb = (r.bytes_downloaded as f64) / (1024.0 * 1024.0);
    let kbps = r.bandwidth_bytes_per_sec / 1024.0;
    println!();
    println!("Sync metrics:");
    println!(
        "  messages:  {} new, {} fetched",
        r.synced, r.messages_fetched
    );
    println!("  downloaded: {:.2} MB ({} bytes)", mb, r.bytes_downloaded);
    println!("  bandwidth: {:.1} KB/s", kbps);
    println!(
        "  throughput: {} msg/min",
        r.messages_per_minute.round() as i64
    );
    println!("  duration:  {sec:.2}s");
    println!("Sync log: {}", r.log_path);
}

pub(crate) fn run_sync_foreground_backward(
    cfg: &zmail::Config,
    since_override: Option<&str>,
) -> Result<SyncResult, Box<dyn std::error::Error>> {
    let home = zmail_home_path();
    if cfg.imap_user.trim().is_empty() || cfg.imap_password.trim().is_empty() {
        return Err("IMAP user/password required. Run `zmail setup`.".into());
    }
    let logger = SyncFileLogger::open(&home)?;
    let mut conn = db::open_file(cfg.db_path())?;
    let mailbox = resolve_sync_mailbox(cfg);
    let since_ymd = resolve_sync_since_ymd(cfg, since_override)?;
    eprintln!("zmail: Connecting to {}…", cfg.imap_host);
    let host = cfg.imap_host.clone();
    let port = cfg.imap_port;
    let user = cfg.imap_user.clone();
    let pass = cfg.imap_password.clone();
    let opts = SyncOptions {
        direction: SyncDirection::Backward,
        since_ymd,
        force: false,
        progress_stderr: true,
    };
    let result = zmail::run_sync_with_parallel_imap_connect(
        &mut conn,
        &logger,
        &mailbox,
        cfg.maildir_path(),
        &cfg.sync_exclude_labels,
        &opts,
        move || connect_imap_session(&host, port, &user, &pass),
    )?;
    eprintln!("zmail: Connected.");
    Ok(result)
}

pub(crate) fn run_sync_foreground_refresh(
    cfg: &zmail::Config,
    force: bool,
    progress_stderr: bool,
) -> Result<SyncResult, Box<dyn std::error::Error>> {
    let home = zmail_home_path();
    if cfg.imap_user.trim().is_empty() || cfg.imap_password.trim().is_empty() {
        return Err("IMAP user/password required. Run `zmail setup`.".into());
    }
    let logger = SyncFileLogger::open(&home)?;
    let mut conn = db::open_file(cfg.db_path())?;
    let mailbox = resolve_sync_mailbox(cfg);
    let since_ymd = resolve_sync_since_ymd(cfg, None)?;
    if progress_stderr {
        eprintln!("zmail: Connecting to {}…", cfg.imap_host);
    }
    let host = cfg.imap_host.clone();
    let port = cfg.imap_port;
    let user = cfg.imap_user.clone();
    let pass = cfg.imap_password.clone();
    let opts = SyncOptions {
        direction: SyncDirection::Forward,
        since_ymd,
        force,
        progress_stderr,
    };
    let result = zmail::run_sync_with_parallel_imap_connect(
        &mut conn,
        &logger,
        &mailbox,
        cfg.maildir_path(),
        &cfg.sync_exclude_labels,
        &opts,
        move || connect_imap_session(&host, port, &user, &pass),
    )?;
    if progress_stderr {
        eprintln!("zmail: Connected.");
    }
    Ok(result)
}

pub(crate) fn run_triage_command(cfg: &zmail::Config, args: &impl InboxCliArgs) -> CliResult {
    let Some(api_key) = resolve_openai_api_key(&LoadConfigOptions {
        home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
        env: None,
    }) else {
        eprintln!(
            "zmail {} requires an LLM API key.",
            args.surface_mode().as_str()
        );
        eprintln!("Set ZMAIL_OPENAI_API_KEY or run 'zmail setup' with --openai-key.");
        std::process::exit(1);
    };

    let window_spec = resolve_inbox_window_spec(args.since(), args.window());
    let spec = window_spec.unwrap_or_else(|| cfg.inbox_default_window.clone());
    let cutoff_iso = match parse_inbox_window_to_iso_cutoff(&spec) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    };

    let mut sync_result = empty_sync_result();
    if args.refresh() {
        sync_result = run_sync_foreground_refresh(cfg, args.force(), args.verbose())?;
    }

    let print_scan = |sync_result: &SyncResult, scan: &zmail::RunInboxScanResult| -> CliResult {
        let hints = inbox_json_hints(
            args.surface_mode(),
            &scan.surfaced,
            &scan.counts,
            scan.candidates_scanned,
            args.diagnostics(),
        );
        match args.surface_mode() {
            InboxSurfaceMode::Check => {
                let json = build_check_json(
                    sync_result,
                    &scan.surfaced,
                    args.diagnostics().then_some(scan.processed.as_slice()),
                    &scan.counts,
                    scan.candidates_scanned,
                    scan.llm_duration_ms,
                    !args.refresh(),
                    &hints,
                    args.inbox_json_full_detail(),
                );
                if args.text() {
                    print_check_text(
                        sync_result,
                        &scan.surfaced,
                        args.diagnostics().then_some(scan.processed.as_slice()),
                        &scan.counts,
                        if args.replay() {
                            "Urgent messages (replay):"
                        } else {
                            "Urgent messages:"
                        },
                        !args.refresh(),
                    );
                } else if args.watch() {
                    println!("{}", serde_json::to_string(&json)?);
                } else {
                    println!("{}", serde_json::to_string_pretty(&json)?);
                }
            }
            InboxSurfaceMode::Review => {
                let json = build_review_json(
                    &scan.surfaced,
                    args.diagnostics().then_some(scan.processed.as_slice()),
                    &scan.counts,
                    scan.candidates_scanned,
                    scan.llm_duration_ms,
                    &hints,
                    args.inbox_json_full_detail(),
                );
                if args.text() {
                    print_review_text(
                        &scan.surfaced,
                        args.diagnostics().then_some(scan.processed.as_slice()),
                        &scan.counts,
                    );
                } else if args.watch() {
                    println!("{}", serde_json::to_string(&json)?);
                } else {
                    println!("{}", serde_json::to_string_pretty(&json)?);
                }
            }
        }
        Ok(())
    };

    let owner = (!cfg.imap_user.trim().is_empty()).then(|| cfg.imap_user.clone());
    let opts = RunInboxScanOptions {
        surface_mode: args.surface_mode(),
        cutoff_iso,
        include_all: args.include_all(),
        replay: args.replay(),
        reapply_llm: args.reclassify(),
        diagnostics: args.diagnostics(),
        rules_fingerprint: None,
        owner_address: owner,
        owner_aliases: cfg.imap_aliases.clone(),
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };

    if args.watch() {
        let scan = run_triage_scan(cfg, args, &api_key, &opts)?;
        print_scan(&sync_result, &scan)?;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(
                args.watch_interval_seconds().max(1),
            ));
            let mut loop_sync = empty_sync_result();
            if args.refresh() {
                loop_sync = run_sync_foreground_refresh(cfg, args.force(), args.verbose())?;
            }
            let scan = run_triage_scan(cfg, args, &api_key, &opts)?;
            print_scan(&loop_sync, &scan)?;
        }
    } else {
        let scan = run_triage_scan(cfg, args, &api_key, &opts)?;
        print_scan(&sync_result, &scan)?;
    }

    Ok(())
}

fn run_triage_scan(
    cfg: &zmail::Config,
    args: &impl InboxCliArgs,
    api_key: &str,
    opts: &RunInboxScanOptions,
) -> Result<zmail::RunInboxScanResult, Box<dyn std::error::Error>> {
    let conn = db::open_file(cfg.db_path())?;
    let owner = (!cfg.imap_user.trim().is_empty()).then(|| cfg.imap_user.clone());
    let owner_ctx = zmail::InboxOwnerContext::from_addresses(owner.as_deref(), &cfg.imap_aliases);
    let rules = load_rules_file(&zmail_home_path())?;
    let mut scan_opts = opts.clone();
    scan_opts.rules_fingerprint = Some(zmail::rules_fingerprint(&rules));
    scan_opts.owner_address = owner;

    let mut classifier =
        OpenAiInboxClassifier::new(api_key, &rules, args.diagnostics(), &owner_ctx);
    let runtime = tokio::runtime::Runtime::new()?;
    let scan = runtime.block_on(run_inbox_scan(&conn, &scan_opts, &mut classifier))?;
    Ok(scan)
}
