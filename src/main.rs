//! zmail CLI binary — Rust port.

use clap::{Parser, Subcommand};
use regex::Regex;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
/// Shown for `zmail --version` (`-V` stays a single line from `version =`).
const CLI_LONG_VERSION: &str = concat!(
    env!("CARGO_PKG_VERSION"),
    "\n\n",
    "Upgrade / reinstall (prebuilt binary):\n",
    "  curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash\n",
    "  curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | INSTALL_PREFIX=~/bin bash\n",
    "  curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash -s -- --nightly\n",
    "\n",
    "If you installed via Homebrew, npm, or cargo, upgrade with that tool instead.\n",
);

use zmail::{
    build_inbox_style_json, build_refresh_json_value, collect_stats, connect_imap_session, db,
    format_read_message_text, handle_request_line, list_attachments_for_message,
    list_thread_messages, load_config, load_refresh_new_mail, parse_inbox_window_to_iso_cutoff,
    parse_read_full, print_inbox_style_text, print_refresh_text, print_status_text,
    read_attachment_text, read_message_bytes_with_thread, read_stored_file, rebuild_from_maildir,
    resolve_message_id, resolve_openai_api_key, resolve_search_json_format, resolve_setup_email,
    resolve_setup_password, resolve_sync_mailbox, resolve_sync_since_ymd, run_ask, run_inbox_scan,
    run_wizard, search_result_to_slim_json_row, search_with_meta, send_draft_by_id,
    send_simple_message, spawn_sync_background_detached, split_address_list, status,
    validate_imap_credentials, validate_openai_key, verify_smtp_credentials, who, write_setup,
    LoadConfigOptions, OpenAiInboxClassifier, ReadMessageJson, RunAskOptions, RunInboxScanOptions,
    SearchOptions, SearchResultFormatPreference, SendSimpleFields, SetupArgs, SyncDirection,
    SyncFileLogger, SyncOptions, WhoOptions, WizardOptions,
};

#[derive(Parser)]
#[command(name = "zmail")]
#[command(about = "zmail: Agent-first email")]
#[command(version = env!("CARGO_PKG_VERSION"), long_version = CLI_LONG_VERSION)]
#[command(
    help_template = "\
{before-help}{about-with-newline}\
{usage-heading} {usage}\
{after-help}\
{options}\
",
    after_help = "Upgrade / reinstall: zmail --version (long text) or zmail --help.\nRun zmail --help for the full command list by workflow.\n",
    after_long_help = include_str!("cli/root_help.txt")
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    // --- Setup & sync (common first) ---
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
    /// Interactive TUI setup (prompts; use `zmail setup` for agents)
    Wizard {
        #[arg(long)]
        no_validate: bool,
        #[arg(long)]
        clean: bool,
        #[arg(long)]
        yes: bool,
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
    /// Sync and search readiness
    Status {
        /// JSON output
        #[arg(long)]
        json: bool,
    },
    // --- Search & read ---
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
        #[arg(long, conflicts_with = "json")]
        text: bool,
        /// Explicit JSON output (default unless `--text` is set; agents often pass this flag)
        #[arg(long, conflicts_with = "text")]
        json: bool,
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
    /// Read one message (raw .eml or headers + body)
    Read {
        message_id: String,
        #[arg(long)]
        raw: bool,
        #[arg(long, conflicts_with = "text")]
        json: bool,
        /// Plain-text headers + body (default unless `--json` or `--raw`)
        #[arg(long, conflicts_with = "json")]
        text: bool,
    },
    /// List messages in a thread
    Thread {
        thread_id: String,
        /// JSON array of thread messages
        #[arg(long, conflicts_with = "text")]
        json: bool,
        /// Plain-text table output (default unless `--json` is set)
        #[arg(long, conflicts_with = "json")]
        text: bool,
    },
    /// List or read message attachments (extracted text / CSV)
    #[command(name = "attachment")]
    Attachment {
        #[command(subcommand)]
        sub: AttachmentCmd,
    },
    // --- Assistants ---
    /// Answer a question about your email (requires ZMAIL_OPENAI_API_KEY)
    Ask {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        question: Vec<String>,
        #[arg(long, short = 'v')]
        verbose: bool,
    },
    /// LLM notable-mail scan for a time window (requires ZMAIL_OPENAI_API_KEY)
    Inbox {
        /// Rolling window e.g. 24h, 3d (optional; use `--since` or config default for YYYY-MM-DD)
        window: Option<String>,
        #[arg(long)]
        since: Option<String>,
        #[arg(long)]
        refresh: bool,
        #[arg(long)]
        force: bool,
        #[arg(long)]
        include_noise: bool,
        #[arg(long)]
        text: bool,
    },
    // --- Send, stats & tools (long tail) ---
    /// Send mail via SMTP (same IMAP credentials; optional `ZMAIL_SEND_TEST=1` guard)
    Send {
        /// Saved draft id (`data/drafts/{id}.md`) when not using `--to` / `--subject`
        draft_id: Option<String>,
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        subject: Option<String>,
        #[arg(long)]
        body: Option<String>,
        #[arg(long)]
        cc: Option<String>,
        #[arg(long)]
        bcc: Option<String>,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        text: bool,
    },
    /// Local drafts under data/drafts/ (list, view, new, reply, forward, edit, rewrite)
    Draft {
        #[command(subcommand)]
        sub: zmail::draft::DraftCmd,
    },
    /// Database counts
    Stats {
        #[arg(long)]
        json: bool,
    },
    /// Rebuild SQLite index from maildir tree
    #[command(name = "rebuild-index")]
    RebuildIndex,
    /// MCP server (JSON-RPC lines on stdin)
    Mcp,
}

#[derive(Subcommand)]
enum AttachmentCmd {
    /// List attachments for a message (JSON unless --text)
    List {
        message_id: String,
        #[arg(long)]
        text: bool,
    },
    /// Print extracted text (or raw bytes with --raw)
    Read {
        message_id: String,
        /// 1-based index or exact filename
        index_or_name: String,
        #[arg(long)]
        raw: bool,
        #[arg(long)]
        no_cache: bool,
    },
}

fn zmail_home_path() -> PathBuf {
    std::env::var("ZMAIL_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().expect("HOME").join(".zmail"))
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

fn empty_sync_result() -> zmail::SyncResult {
    zmail::SyncResult {
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
    println!("  downloaded: {:.2} MB ({} bytes)", mb, r.bytes_downloaded);
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

fn format_attachment_size(n: i64) -> String {
    if n >= 1024 * 1024 {
        format!("{:.2} MB", n as f64 / (1024.0 * 1024.0))
    } else if n >= 1024 {
        format!("{:.2} KB", n as f64 / 1024.0)
    } else {
        format!("{n} B")
    }
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
                let cfg = load_config(LoadConfigOptions {
                    home: Some(home.clone()),
                    env: None,
                });
                print!("Validating IMAP... ");
                std::io::stdout().flush().ok();
                if validate_imap_credentials(
                    &cfg.imap_host,
                    cfg.imap_port,
                    &cfg.imap_user,
                    &cfg.imap_password,
                )
                .is_err()
                {
                    println!("Failed");
                    eprintln!("Could not connect to IMAP. Check your credentials.");
                    std::process::exit(1);
                }
                println!("OK");
                print!("Validating SMTP... ");
                std::io::stdout().flush().ok();
                if verify_smtp_credentials(&cfg.imap_host, &cfg.imap_user, &cfg.imap_password)
                    .is_err()
                {
                    println!("Failed");
                    eprintln!("Could not verify SMTP. Check your credentials and network.");
                    std::process::exit(1);
                }
                println!("OK");
                let Some(api_key) = resolve_openai_api_key(&LoadConfigOptions {
                    home: Some(home.clone()),
                    env: None,
                }) else {
                    println!("Failed");
                    eprintln!("OpenAI API key missing after setup.");
                    std::process::exit(1);
                };
                print!("Validating OpenAI API key... ");
                std::io::stdout().flush().ok();
                if validate_openai_key(&api_key).is_err() {
                    println!("Failed");
                    eprintln!("Invalid API key.");
                    std::process::exit(1);
                }
                println!("OK");
            }
            println!("Wrote config under {}", home.display());
        }
        Commands::Ask {
            mut question,
            verbose,
        } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            if question.first().is_some_and(|s| s == "--") {
                question.remove(0);
            }
            let q = question.join(" ");
            let q = q.trim();
            if q.is_empty() {
                eprintln!("Usage: zmail ask <question> [--verbose]");
                eprintln!("  Answer a question about your email using an internal agent (requires ZMAIL_OPENAI_API_KEY).");
                eprintln!();
                eprintln!("Example: zmail ask \"summarize my tech news this week\"");
                eprintln!("  Use --verbose (or -v) to log pipeline progress (phase 1, context assembly, etc.).");
                std::process::exit(1);
            }
            let Some(api_key) = resolve_openai_api_key(&LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            }) else {
                eprintln!("zmail ask requires an LLM API key.");
                eprintln!("Set ZMAIL_OPENAI_API_KEY or run 'zmail setup' with --openai-key.");
                std::process::exit(1);
            };
            let conn = db::open_file(cfg.db_path())?;
            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(run_ask(
                q,
                &conn,
                &cfg.data_dir,
                &cfg.imap_user,
                cfg.attachments_cache_extracted_text,
                &api_key,
                RunAskOptions {
                    stream: true,
                    verbose,
                },
            ))?;
        }
        Commands::Send {
            draft_id,
            to,
            subject,
            body,
            cc,
            bcc,
            dry_run,
            text,
        } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            if cfg.imap_user.trim().is_empty() || cfg.imap_password.is_empty() {
                eprintln!("IMAP user/password required. Run `zmail setup`.");
                std::process::exit(1);
            }
            let use_json = !text;
            if let (Some(to_s), Some(subj)) = (to.as_ref(), subject.as_ref()) {
                let body_text = body.clone().unwrap_or_default();
                let fields = SendSimpleFields {
                    to: split_address_list(to_s),
                    cc: cc
                        .as_ref()
                        .map(|s| split_address_list(s))
                        .filter(|v| !v.is_empty()),
                    bcc: bcc
                        .as_ref()
                        .map(|s| split_address_list(s))
                        .filter(|v| !v.is_empty()),
                    subject: subj.clone(),
                    text: body_text,
                    in_reply_to: None,
                    references: None,
                };
                let result = send_simple_message(&cfg, &fields, dry_run)?;
                if use_json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    print!("ok={} messageId={}", result.ok, result.message_id);
                    if result.dry_run == Some(true) {
                        print!(" dryRun=true");
                    }
                    println!();
                    if let Some(ref r) = result.smtp_response {
                        println!("{r}");
                    }
                }
            } else if let Some(id) = draft_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let result = send_draft_by_id(&cfg, &cfg.data_dir, id, dry_run)?;
                if use_json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    print!("ok={} messageId={}", result.ok, result.message_id);
                    if result.dry_run == Some(true) {
                        print!(" dryRun=true");
                    }
                    println!();
                    if let Some(ref r) = result.smtp_response {
                        println!("{r}");
                    }
                }
            } else {
                eprintln!(
                    "Usage: zmail send --to <addr> --subject <s> [--body <text>] [--cc ...] [--bcc ...] [--dry-run]"
                );
                eprintln!("       zmail send <draft-id>");
                std::process::exit(1);
            }
        }
        Commands::Draft { sub } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            if cfg.imap_user.trim().is_empty() || cfg.imap_password.is_empty() {
                eprintln!("IMAP user/password required. Run `zmail setup`.");
                std::process::exit(1);
            }
            let needs_db = matches!(
                &sub,
                zmail::draft::DraftCmd::Reply { .. } | zmail::draft::DraftCmd::Forward { .. }
            );
            let conn_owned = if needs_db {
                Some(db::open_file(cfg.db_path())?)
            } else {
                None
            };
            zmail::draft::run_draft(sub, &cfg, conn_owned.as_ref())?;
        }
        Commands::Inbox {
            window,
            since,
            refresh: do_refresh,
            force,
            include_noise,
            text: force_text,
        } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let Some(api_key) = resolve_openai_api_key(&LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            }) else {
                eprintln!("zmail inbox requires an LLM API key.");
                eprintln!("Set ZMAIL_OPENAI_API_KEY or run 'zmail setup' with --openai-key.");
                std::process::exit(1);
            };
            let window_spec = resolve_inbox_window_spec(since, window);
            let spec = window_spec.unwrap_or_else(|| cfg.inbox_default_window.clone());
            let cutoff_iso = match parse_inbox_window_to_iso_cutoff(&spec) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            };
            let mut sync_result = empty_sync_result();
            if do_refresh {
                sync_result = run_sync_foreground_refresh(&cfg, force)?;
            }
            let conn = db::open_file(cfg.db_path())?;
            let owner = (!cfg.imap_user.trim().is_empty()).then(|| cfg.imap_user.clone());
            let opts = RunInboxScanOptions {
                cutoff_iso,
                include_noise,
                owner_address: owner,
                candidate_cap: None,
                notable_cap: None,
                batch_size: None,
            };
            let mut classifier = OpenAiInboxClassifier::new(&api_key);
            let rt = tokio::runtime::Runtime::new()?;
            let scan = rt.block_on(run_inbox_scan(&conn, &opts, &mut classifier))?;
            let json = build_inbox_style_json(
                &sync_result,
                &scan.new_mail,
                scan.candidates_scanned,
                scan.llm_duration_ms,
                !do_refresh,
            );
            if force_text {
                print_inbox_style_text(&sync_result, &scan.new_mail, "Inbox:", !do_refresh);
            } else {
                println!("{}", serde_json::to_string_pretty(&json)?);
            }
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
        Commands::Read {
            message_id,
            raw,
            json,
            text: _text,
        } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let conn = db::open_file(cfg.db_path())?;
            let (bytes, _mid, thread_id) =
                read_message_bytes_with_thread(&conn, &message_id, &cfg.data_dir)??;
            if raw {
                std::io::stdout().write_all(&bytes)?;
            } else {
                let parsed = parse_read_full(&bytes);
                if json {
                    let out = ReadMessageJson::from_parsed(&parsed, &thread_id);
                    println!("{}", serde_json::to_string_pretty(&out)?);
                } else {
                    print!("{}", format_read_message_text(&parsed));
                }
            }
        }
        Commands::Thread {
            thread_id,
            json,
            text: _text,
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
                    println!(
                        "{}  {}  {}",
                        &r.date[..r.date.len().min(10)],
                        r.from_address,
                        r.subject
                    );
                }
            }
        }
        Commands::Attachment { sub } => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let conn = db::open_file(cfg.db_path())?;
            let cache = cfg.attachments_cache_extracted_text;
            match sub {
                AttachmentCmd::List { message_id, text } => {
                    let exists = resolve_message_id(&conn, &message_id)?.is_some();
                    if !exists {
                        if text {
                            println!("No attachments found.");
                        } else {
                            println!("[]");
                        }
                        return Ok(());
                    }
                    let rows = list_attachments_for_message(&conn, &message_id)?;
                    if text {
                        if rows.is_empty() {
                            println!("No attachments found.");
                        } else {
                            println!("Attachments for {message_id}:\n");
                            println!(
                                "  {:>4}  {:<40}  {:<38}  {:>9}  EXTRACTED",
                                "#", "FILENAME", "MIME TYPE", "SIZE"
                            );
                            println!("  {}", "-".repeat(100));
                            for r in &rows {
                                let size_str = format_attachment_size(r.size);
                                let fname = if r.filename.len() > 40 {
                                    format!("{}...", &r.filename[..37])
                                } else {
                                    format!("{:<40}", r.filename)
                                };
                                let mime = if r.mime_type.len() > 38 {
                                    format!("{}...", &r.mime_type[..35])
                                } else {
                                    format!("{:<38}", r.mime_type)
                                };
                                println!(
                                    "  {:>4}  {}  {}  {:>9}  {}",
                                    r.index,
                                    fname,
                                    mime,
                                    size_str,
                                    if r.extracted { "yes" } else { "no" }
                                );
                            }
                        }
                    } else {
                        let json_rows: Vec<serde_json::Value> = rows
                            .iter()
                            .enumerate()
                            .map(|(i, a)| {
                                serde_json::json!({
                                    "index": i + 1,
                                    "filename": &a.filename,
                                    "mimeType": &a.mime_type,
                                    "size": a.size,
                                    "extracted": a.extracted,
                                })
                            })
                            .collect();
                        println!("{}", serde_json::to_string_pretty(&json_rows)?);
                    }
                }
                AttachmentCmd::Read {
                    message_id,
                    index_or_name,
                    raw,
                    no_cache,
                } => {
                    let rows = list_attachments_for_message(&conn, &message_id)?;
                    if rows.is_empty() {
                        eprintln!("No attachments found for message.");
                        std::process::exit(1);
                    }
                    let att = if let Ok(n) = index_or_name.parse::<usize>() {
                        if n >= 1 && n <= rows.len() {
                            &rows[n - 1]
                        } else {
                            eprintln!(
                                "No attachment \"{}\" in this message. Use index 1-{}",
                                index_or_name,
                                rows.len()
                            );
                            std::process::exit(1);
                        }
                    } else if let Some(a) =
                        rows.iter().find(|a| a.filename == index_or_name.as_str())
                    {
                        a
                    } else {
                        eprintln!(
                                "No attachment \"{}\" in this message. Use index 1-{} or exact filename.",
                                index_or_name,
                                rows.len()
                            );
                        std::process::exit(1);
                    };
                    if raw {
                        let bytes = read_stored_file(&att.stored_path, &cfg.data_dir)?;
                        std::io::stdout().write_all(&bytes)?;
                    } else {
                        let text =
                            read_attachment_text(&conn, &cfg.data_dir, att.id, cache, no_cache)
                                .map_err(std::io::Error::other)?;
                        println!("{text}");
                    }
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
            println!(
                "Reindexed {n} messages from {}",
                cfg.maildir_path().display()
            );
        }
        Commands::Mcp => {
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            });
            let conn = db::open_file(cfg.db_path())?;
            let cache = cfg.attachments_cache_extracted_text;
            let stdin = std::io::stdin();
            for line in stdin.lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let resp = handle_request_line(&conn, &cfg.data_dir, cache, &line);
                println!("{resp}");
            }
        }
        Commands::Wizard {
            no_validate,
            clean,
            yes,
        } => {
            let home = std::env::var("ZMAIL_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| dirs::home_dir().expect("HOME").join(".zmail"));
            run_wizard(WizardOptions {
                home,
                no_validate,
                clean,
                yes,
            })?;
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
            json: _json,
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
                let fmt = resolve_search_json_format(run.results.len(), pref, true);
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
                let home = zmail_home_path();
                spawn_sync_background_detached(&home, &cfg, since_spec)?;
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
                let latest_mail_ago =
                    status::format_time_ago(s.date_range.as_ref().map(|(_, l)| l.as_str()));
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
