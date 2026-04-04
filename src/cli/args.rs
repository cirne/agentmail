use clap::{Args, Parser, Subcommand};

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
    after_long_help = include_str!("root_help.txt")
)]
pub(crate) struct Cli {
    #[command(subcommand)]
    pub(crate) command: Commands,
}

#[derive(Subcommand)]
pub(crate) enum Commands {
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
    /// Fetch mail from IMAP: forward sync by default; use --since for backfill / initial history
    #[command(name = "refresh")]
    Refresh {
        /// Positional duration (e.g. `7d`, `180d`, `1y`) — same as `--since`
        duration: Option<String>,
        /// Rolling window — overrides `sync.defaultSince` when set
        #[arg(long)]
        since: Option<String>,
        #[arg(long, alias = "fg")]
        foreground: bool,
        #[arg(long)]
        force: bool,
        #[arg(long)]
        text: bool,
    },
    /// Sync and search readiness
    Status {
        #[arg(long)]
        json: bool,
        #[arg(long, alias = "server")]
        imap: bool,
    },
    /// Full-text search (JSON by default)
    Search {
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
        include_all: bool,
        #[arg(long)]
        category: Option<String>,
        #[arg(long, conflicts_with = "json")]
        text: bool,
        #[arg(long, conflicts_with = "text")]
        json: bool,
        #[arg(long, value_parser = ["auto", "full", "slim"])]
        result_format: Option<String>,
        #[arg(long)]
        timings: bool,
    },
    /// Top contacts / people search
    Who {
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
        #[arg(long, conflicts_with = "json")]
        text: bool,
    },
    /// List messages in a thread
    Thread {
        thread_id: String,
        #[arg(long, conflicts_with = "text")]
        json: bool,
        #[arg(long, conflicts_with = "json")]
        text: bool,
    },
    /// List or read message attachments (extracted text / CSV)
    #[command(name = "attachment")]
    Attachment {
        #[command(subcommand)]
        sub: AttachmentCmd,
    },
    /// Answer a question about your email (requires ZMAIL_OPENAI_API_KEY)
    Ask {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        question: Vec<String>,
        #[arg(long, short = 'v')]
        verbose: bool,
    },
    /// LLM inbox triage over the local index (no IMAP sync; run `zmail refresh` when recency matters)
    Inbox(InboxArgs),
    /// Archive messages locally (`is_archived`); optional IMAP when mailboxManagement is enabled
    Archive {
        /// One or more RFC Message-IDs
        #[arg(required = true)]
        message_ids: Vec<String>,
        #[arg(long)]
        undo: bool,
    },
    /// Send mail via SMTP (same IMAP credentials; optional `ZMAIL_SEND_TEST=1` guard)
    Send {
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
    /// Manage inbox rules and context in ~/.zmail/rules.json
    Rules {
        #[command(subcommand)]
        sub: RulesCmd,
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
pub(crate) enum AttachmentCmd {
    /// List attachments for a message (JSON unless --text)
    List {
        message_id: String,
        #[arg(long)]
        text: bool,
    },
    /// Print extracted text (or raw bytes with --raw)
    Read {
        message_id: String,
        index_or_name: String,
        #[arg(long)]
        raw: bool,
        #[arg(long)]
        no_cache: bool,
    },
}

#[derive(Args, Debug, Clone, Default)]
pub(crate) struct InboxArgs {
    /// Rolling window e.g. 24h, 3d (optional; use `--since` or config default for YYYY-MM-DD)
    pub(crate) window: Option<String>,
    #[arg(long)]
    pub(crate) since: Option<String>,
    /// Slow path: all categories; rerun LLM (bypass cache); include archived; ignore prior surfaced dedup
    #[arg(long)]
    pub(crate) thorough: bool,
    #[arg(long, hide = true)]
    pub(crate) replay: bool,
    #[arg(long, hide = true)]
    pub(crate) include_all: bool,
    #[arg(long, hide = true)]
    pub(crate) reclassify: bool,
    #[arg(long)]
    pub(crate) diagnostics: bool,
    #[arg(long)]
    pub(crate) text: bool,
}

#[derive(Subcommand, Debug, Clone)]
pub(crate) enum RulesCmd {
    /// Show all rules and context
    List {
        #[arg(long)]
        text: bool,
    },
    /// Show a single rule or context entry by ID
    Show {
        id: String,
        #[arg(long)]
        text: bool,
    },
    /// Add a new rule
    Add {
        #[arg(long)]
        action: String,
        condition: String,
        #[arg(long)]
        no_preview: bool,
        #[arg(long)]
        preview_window: Option<String>,
        #[arg(long)]
        text: bool,
    },
    /// Edit an existing rule
    Edit {
        id: String,
        #[arg(long)]
        condition: Option<String>,
        #[arg(long)]
        action: Option<String>,
        #[arg(long)]
        no_preview: bool,
        #[arg(long)]
        preview_window: Option<String>,
        #[arg(long)]
        text: bool,
    },
    /// Remove a rule by ID
    Remove {
        id: String,
        #[arg(long)]
        text: bool,
    },
    /// Manage context entries
    Context {
        #[command(subcommand)]
        sub: RulesContextCmd,
    },
    /// Propose a rule from fuzzy feedback
    Feedback {
        feedback: String,
        #[arg(long)]
        text: bool,
    },
}

#[derive(Subcommand, Debug, Clone)]
pub(crate) enum RulesContextCmd {
    Add {
        text: String,
        #[arg(long)]
        text_mode: bool,
    },
    Remove {
        id: String,
        #[arg(long)]
        text: bool,
    },
}

#[cfg(test)]
mod draft_cli_tests {
    use super::Cli;
    use clap::Parser;
    use zmail::draft::DraftCmd;

    #[test]
    fn draft_list_accepts_json_flag_for_agents() {
        let cli = Cli::try_parse_from(["zmail", "draft", "list", "--json"]).expect("parse");
        match cli.command {
            super::Commands::Draft { sub } => match sub {
                DraftCmd::List {
                    text: false,
                    json: true,
                    ..
                } => {}
                _ => panic!("unexpected draft subcommand"),
            },
            _ => panic!("expected draft list"),
        }
    }

    #[test]
    fn draft_list_text_conflicts_with_json() {
        let err = match Cli::try_parse_from(["zmail", "draft", "list", "--text", "--json"]) {
            Err(e) => e,
            Ok(_) => panic!("expected --text/--json conflict"),
        };
        let s = err.to_string();
        assert!(
            s.contains("text") && s.contains("json") || s.contains("cannot be used with"),
            "{s}"
        );
    }
}
