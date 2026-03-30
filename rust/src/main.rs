//! zmail CLI binary — Rust port.

use clap::{Parser, Subcommand};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::thread;
use std::time::Duration;
use zmail::{
    build_refresh_json_value, collect_stats, connect_imap_session, db, handle_request_line,
    is_sync_lock_held, list_thread_messages, load_config, load_refresh_new_mail, print_refresh_text,
    print_status_text, read_message_bytes, rebuild_from_maildir, resolve_search_json_format,
    resolve_setup_email, resolve_setup_password, resolve_sync_mailbox, resolve_sync_since_ymd,
    search_result_to_slim_json_row, search_with_meta, status,
    sync_log_path, who, write_setup, LoadConfigOptions, SearchOptions,
    SearchResultFormatPreference, SetupArgs, SyncDirection, SyncFileLogger, SyncLockRow, SyncOptions,
    WhoOptions,
};

#[derive(Parser)]
#[command(name = "zmail")]
#[command(about = "Agent-first email — Rust port (work in progress)")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Full-text search (JSON by default)
    Search {
        /// Search query (supports from:, after:, subject:, …)
        query: String,
        #[arg(long)]
        limit: Option<usize>,
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        after: Option<String>,
        #[arg(long)]
        before: Option<String>,
        #[arg(long)]
        include_noise: bool,
        /// Plain-text table output
        #[arg(long)]
        text: bool,
        #[arg(long, value_parser = ["auto", "full", "slim"])]
        result_format: Option<String>,
        #[arg(long)]
        timings: bool,
    },
    /// Top contacts / people search
    Who {
        /// Filter by name or address (omit for top contacts)
        query: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: usize,
        #[arg(long)]
        include_noreply: bool,
        #[arg(long)]
        text: bool,
    },
    /// Write ~/.zmail config (non-interactive)
    Setup {
        #[arg(long)]
        email: Option<String>,
        #[arg(long)]
        password: Option<String>,
        #[arg(long)]
        openai_key: Option<String>,
        #[arg(long)]
        no_validate: bool,
    },
    /// Database counts
    Stats {
        #[arg(long)]
        json: bool,
    },
    /// Read one message (raw .eml or body text)
    Read {
        message_id: String,
        #[arg(long)]
        raw: bool,
    },
    /// List messages in a thread
    Thread {
        thread_id: String,
        #[arg(long)]
        json: bool,
    },
    /// Rebuild SQLite index from maildir tree
    #[command(name = "rebuild-index")]
    RebuildIndex,
    /// MCP server (JSON-RPC lines on stdin)
    Mcp,
    /// Interactive setup (stub — prefer `zmail setup`)
    Wizard,
    /// Sync and search readiness
    Status {
        /// JSON output
        #[arg(long)]
        json: bool,
    },
    /// Backfill mail (backward sync). Default: background subprocess; use --foreground to block.
    Sync {
        /// Positional duration (e.g. `7d`, `180d`, `1y`) — same as `--since`
        duration: Option<String>,
        /// Rolling window — overrides `sync.defaultSince` when set
        #[arg(long)]
        since: Option<String>,
        #[arg(long, alias = "fg")]
        foreground: bool,
    },
    /// Fetch new messages since last checkpoint (forward sync)
    Refresh {
        #[arg(long)]
        force: bool,
        #[arg(long)]
        include_noise: bool,
        #[arg(long)]
        text: bool,
    },
}

fn zmail_home_path() -> PathBuf {
    std::env::var("ZMAIL_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().expect("HOME").join(".zmail"))
}

fn print_sync_foreground_metrics(r: &zmail::SyncResult) {
    let sec = (r.duration_ms as f64) / 1000.0;
    let mb = (r.bytes_downloaded as f64) / (1024.0 * 1024.0);
    let kbps = r.bandwidth_bytes_per_sec / 1024.0;
    println!();
    println!("Sync metrics:");
    println!(
        "  messages:  {} new, {} fetched",
        r.synced, r.messages_fetched
    );
    println!(
        "  downloaded: {:.2} MB ({} bytes)",
        mb, r.bytes_downloaded
    );
    println!("  bandwidth: {:.1} KB/s", kbps);
    println!(
        "  throughput: {} msg/min",
        r.messages_per_minute.round() as i64
    );
    println!("  duration:  {sec:.2}s");
    println!("Sync log: {}", r.log_path);
}

fn run_sync_foreground_backward(
    cfg: &zmail::Config,
    since_override: Option<&str>,
) -> Result<zmail::SyncResult, Box<dyn std::error::Error>> {
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
    let r = zmail::run_sync_with_parallel_imap_connect(
        &mut conn,
        &logger,
        &mailbox,
        cfg.maildir_path(),
        &cfg.sync_exclude_labels,
        &opts,
        move || connect_imap_session(&host, port, &user, &pass),
    )?;
    eprintln!("zmail: Connected.");
    Ok(r)
}

fn run_sync_foreground_refresh(
    cfg: &zmail::Config,
    force: bool,
) -> Result<zmail::SyncResult, Box<dyn std::error::Error>> {
    let home = zmail_home_path();
    if cfg.imap_user.trim().is_empty() || cfg.imap_password.trim().is_empty() {
        return Err("IMAP user/password required. Run `zmail setup`.".into());
    }
    let logger = SyncFileLogger::open(&home)?;
    let mut conn = db::open_file(cfg.db_path())?;
    let mailbox = resolve_sync_mailbox(cfg);
    let since_ymd = resolve_sync_since_ymd(cfg, None)?;
    eprintln!("zmail: Connecting to {}…", cfg.imap_host);
    let host = cfg.imap_host.clone();
    let port = cfg.imap_port;
    let user = cfg.imap_user.clone();
    let pass = cfg.imap_password.clone();
    let opts = SyncOptions {
        direction: SyncDirection::Forward,
        since_ymd,
        force,
        progress_stderr: true,
    };
    let r = zmail::run_sync_with_parallel_imap_connect(
        &mut conn,
        &logger,
        &mailbox,
        cfg.maildir_path(),
        &cfg.sync_exclude_labels,
        &opts,
        move || connect_imap_session(&host, port, &user, &pass),
    )?;
    eprintln!("zmail: Connected.");
    Ok(r)
}

fn run_sync_background(cfg: &zmail::Config, since_override: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let home = zmail_home_path();
    if cfg.imap_user.trim().is_empty() || cfg.imap_password.trim().is_empty() {
        return Err("IMAP user/password required. Run `zmail setup`.".into());
    }
    let conn = db::open_file(cfg.db_path())?;
    let lock_row: Option<SyncLockRow> = conn
        .query_row(
            "SELECT is_running, owner_pid, sync_lock_started_at FROM sync_summary WHERE id = 1",
            [],
            |row| {
                Ok(SyncLockRow {
                    is_running: row.get(0)?,
                    owner_pid: row.get(1)?,
                    sync_lock_started_at: row.get(2)?,
                })
            },
        )
        .ok();
    if is_sync_lock_held(lock_row.as_ref()) {
        println!(
            "Sync already running (PID: {:?})\n",
            lock_row.and_then(|r| r.owner_pid)
        );
        print_status_text(&conn)?;
        return Ok(());
    }
    drop(conn);

    let mut auth = connect_imap_session(
        &cfg.imap_host,
        cfg.imap_port,
        &cfg.imap_user,
        &cfg.imap_password,
    )?;
    let _ = auth.logout();

    let exe = std::env::current_exe()?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("sync").arg("--foreground");
    if let Some(s) = since_override {
        if !s.is_empty() {
            cmd.arg("--since").arg(s);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn()?;

    let log = sync_log_path(&home);
    println!("Sync log: {}", log.display());

    let start_count: i64 = {
        let c = db::open_file(cfg.db_path())?;
        c.query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))?
    };
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(60) {
        thread::sleep(Duration::from_secs(2));
        let c = db::open_file(cfg.db_path())?;
        let count: i64 = c.query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))?;
        if count > start_count {
            println!("Sync running… {count} messages in index");
            return Ok(());
        }
    }
    println!(
        "Sync started in background. Check `zmail status` or tail {}",
        log.display()
    );
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Setup {
            email,
            password,
            openai_key,
            no_validate,
        } => {
            let home = std::env::var("ZMAIL_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| dirs::home_dir().expect("HOME").join(".zmail"));
            let env_map: HashMap<String, String> = std::env::vars().collect();
            let args = SetupArgs {
                email,
                password,
                openai_key: openai_key.clone(),
                no_validate,
            };
            let Some(em) = resolve_setup_email(&args, &env_map) else {
                return Err("Provide --email or set ZMAIL_EMAIL".into());
            };
            let Some(pw) = resolve_setup_password(&args, &env_map) else {
                return Err("Provide --password or set ZMAIL_IMAP_PASSWORD".into());
            };
            write_setup(&home, &em, &pw, openai_key.as_deref())?;
            if !no_validate {
                eprintln!("Note: credential validation not yet implemented in Rust port.");
            }
            println!("Wrote config under {}", home.display());
        }
        Commands::Stats { json } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let conn = db::open_file(cfg.db_path())?;
            let st = collect_stats(&conn)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&st)?);
            } else {
                println!(
                    "messages={} threads={} attachments={} people={}",
                    st.message_count, st.thread_count, st.attachment_count, st.people_count
                );
            }
        }
        Commands::Read { message_id, raw } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let conn = db::open_file(cfg.db_path())?;
            let bytes = read_message_bytes(&conn, &message_id, &cfg.data_dir)??;
            if raw {
                use std::io::Write;
                std::io::stdout().write_all(&bytes)?;
            } else {
                let p = zmail::parse_raw_message(&bytes);
                print!("{}", p.body_text);
            }
        }
        Commands::Thread {
            thread_id,
            json,
        } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let conn = db::open_file(cfg.db_path())?;
            let rows = list_thread_messages(&conn, &thread_id)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&rows)?);
            } else {
                for r in rows {
                    println!("{}  {}  {}", &r.date[..r.date.len().min(10)], r.from_address, r.subject);
                }
            }
        }
        Commands::RebuildIndex => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let mut conn = db::open_file(cfg.db_path())?;
            let n = rebuild_from_maildir(&mut conn, cfg.maildir_path())?;
            println!("Reindexed {n} messages from {}", cfg.maildir_path().display());
        }
        Commands::Mcp => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let conn = db::open_file(cfg.db_path())?;
            let stdin = std::io::stdin();
            for line in stdin.lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let resp = handle_request_line(&conn, &cfg.data_dir, &line);
                println!("{resp}");
            }
        }
        Commands::Wizard => {
            eprintln!("Use: zmail setup --email you@x.com --password app-pass [--no-validate]");
            std::process::exit(1);
        }
        Commands::Who {
            query,
            limit,
            include_noreply,
            text,
        } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let conn = db::open_file(cfg.db_path())?;
            let opts = WhoOptions {
                query: query.unwrap_or_default(),
                limit,
                include_noreply,
            };
            let run = who(&conn, &opts)?;
            if text {
                for p in &run.people {
                    println!(
                        "{}  sent={} recv={}  rank={:.2}",
                        p.primary_address, p.sent_count, p.received_count, p.contact_rank
                    );
                }
            } else {
                println!("{}", serde_json::to_string_pretty(&run)?);
            }
        }
        Commands::Search {
            query,
            limit,
            from,
            after,
            before,
            include_noise,
            text,
            result_format,
            timings,
        } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let conn = db::open_file(cfg.db_path())?;
            let owner = (!cfg.imap_user.trim().is_empty()).then(|| cfg.imap_user.clone());
            let opts = SearchOptions {
                query: Some(query),
                limit,
                from_address: from,
                after_date: after,
                before_date: before,
                include_noise,
                owner_address: owner,
                ..Default::default()
            };
            let run = search_with_meta(&conn, &opts)?;
            let pref = match result_format.as_deref() {
                Some("full") => SearchResultFormatPreference::Full,
                Some("slim") => SearchResultFormatPreference::Slim,
                _ => SearchResultFormatPreference::Auto,
            };
            if text {
                let n = run.results.len();
                let total = run.total_matched.unwrap_or(n as i64);
                println!(
                    "Found {n} result{}{}",
                    if n == 1 { "" } else { "s" },
                    if total > n as i64 {
                        format!(" (of {total} total)")
                    } else {
                        String::new()
                    }
                );
                for r in &run.results {
                    println!(
                        "{}  {}  {}",
                        &r.date[..r.date.len().min(10)],
                        r.from_address,
                        r.subject
                    );
                }
            } else {
                let fmt = resolve_search_json_format(
                    run.results.len(),
                    pref,
                    true,
                );
                let rows: Vec<serde_json::Value> = match fmt {
                    zmail::SearchJsonFormat::Slim => run
                        .results
                        .iter()
                        .map(search_result_to_slim_json_row)
                        .collect(),
                    zmail::SearchJsonFormat::Full => run
                        .results
                        .iter()
                        .map(|r| serde_json::to_value(r).unwrap())
                        .collect(),
                };
                let mut out = serde_json::json!({
                    "results": rows,
                    "totalMatched": run.total_matched.unwrap_or(rows.len() as i64),
                });
                if timings {
                    out["timings"] = serde_json::to_value(&run.timings)?;
                }
                println!("{}", serde_json::to_string_pretty(&out)?);
            }
        }
        Commands::Sync {
            duration,
            since,
            foreground,
        } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let since_spec = since
                .as_deref()
                .or(duration.as_deref())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if foreground {
                let r = run_sync_foreground_backward(&cfg, since_spec)?;
                print_sync_foreground_metrics(&r);
            } else {
                run_sync_background(&cfg, since_spec)?;
            }
        }
        Commands::Refresh {
            force,
            include_noise,
            text,
        } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let conn = db::open_file(cfg.db_path())?;
            let r = run_sync_foreground_refresh(&cfg, force)?;
            let ids = r.new_message_ids.clone().unwrap_or_default();
            let new_mail = load_refresh_new_mail(
                &conn,
                &ids,
                include_noise,
                (!cfg.imap_user.trim().is_empty()).then_some(cfg.imap_user.as_str()),
            )?;
            if text {
                print_refresh_text(&r, &new_mail);
            } else {
                let v = build_refresh_json_value(&r, &new_mail);
                println!("{}", serde_json::to_string_pretty(&v)?);
            }
        }
        Commands::Status { json } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let conn = db::open_file(cfg.db_path())?;
            if json {
                let s = status::get_status(&conn)?;
                let latest_mail_ago = status::format_time_ago(
                    s.date_range
                        .as_ref()
                        .map(|(_, l)| l.as_str()),
                );
                let last_sync_ago = if s.sync.is_running {
                    None
                } else {
                    status::format_time_ago(s.sync.last_sync_at.as_deref())
                };
                let out = serde_json::json!({
                    "sync": {
                        "isRunning": s.sync.is_running,
                        "lastSyncAt": s.sync.last_sync_at,
                        "totalMessages": s.sync.total_messages,
                        "earliestSyncedDate": s.sync.earliest_synced_date,
                        "latestSyncedDate": s.sync.latest_synced_date,
                        "targetStartDate": s.sync.target_start_date,
                        "syncStartEarliestDate": s.sync.sync_start_earliest_date,
                    },
                    "search": { "ftsReady": s.fts_ready },
                    "dateRange": s.date_range.as_ref().map(|(a, b)| serde_json::json!({
                        "earliest": a,
                        "latest": b,
                    })),
                    "freshness": {
                        "latestMailAgo": latest_mail_ago.as_ref().map(|t| serde_json::json!({
                            "human": t.human,
                            "duration": t.duration,
                        })),
                        "lastSyncAgo": last_sync_ago.as_ref().map(|t| serde_json::json!({
                            "human": t.human,
                            "duration": t.duration,
                        })),
                    },
                });
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                print_status_text(&conn)?;
                println!();
                println!("Hint: Add --imap flag to show IMAP server status (may take 10+ seconds longer)");
            }
        }
    }

    Ok(())
}
