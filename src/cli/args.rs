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
    /// Inbox triage over the local index (deterministic rules; no IMAP sync; run `zmail refresh` when recency matters)
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
    /// Manage inbox rules in ~/.zmail/rules.json
    #[command(after_long_help = RULES_CMD_AFTER_LONG_HELP)]
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
    /// Slow path: all categories; recompute classifications (bypass cache); include archived; ignore prior surfaced dedup
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

/// Appended to `zmail rules --help` (long help only).
const RULES_CMD_AFTER_LONG_HELP: &str = "\
Examples (add: at least one pattern; see zmail rules add --help):
  zmail rules add --action ignore --from-pattern '@linkedin\\.com'
  zmail rules add --action notify --subject-pattern '(?i)verification|security code'
  zmail rules move def-linkedin --before def-cat-list   # see zmail rules move --help; prints compact full order
";

/// Appended to `zmail rules add --help` (long help only).
const RULES_ADD_AFTER_LONG_HELP: &str = "\
Pass at least one of --subject-pattern, --body-pattern, --from-pattern (body = full messages.body_text, not inbox preview). Optional categoryPattern/fromDomainPattern in rules.json; zmail rules validate.
Examples:
  zmail rules add --action ignore --from-pattern '@linkedin\\.com'
  zmail rules add --action inform --subject-pattern '(?i)flight|itinerary'
  zmail rules add --action ignore --body-pattern '(?i)unsubscribe'
  zmail rules add --action notify --from-pattern '^billing@bank\\.example$'
Flags: --action <ACTION> --subject-pattern <RE> --body-pattern <RE> --from-pattern <RE> [--insert-before <RULE_ID>] [--description] [--no-preview] [--preview-window] [--text]
";

/// Appended to `zmail rules move --help` (long help only).
const RULES_MOVE_AFTER_LONG_HELP: &str = "\
Pass exactly one of --before or --after (another rule id). Precedence is list order (earlier = higher).
JSON stdout: { \"moved\": \"<id>\", \"rules\": [ { \"id\", \"action\" }, ... ] } for the full order after the move. --text: numbered lines (index, id, action).
Examples:
  zmail rules move def-linkedin --before def-cat-list
  zmail rules move abc1 --after def-noreply --text
";

#[derive(Subcommand, Debug, Clone)]
pub(crate) enum RulesCmd {
    /// Validate ~/.zmail/rules.json (schema, regex compile)
    Validate,
    /// Replace rules.json with bundled defaults (renames existing file to rules.json.bak.<uuid>)
    ResetDefaults {
        /// Required: confirm destructive replace
        #[arg(long)]
        yes: bool,
    },
    /// Show all rules
    List {
        #[arg(long)]
        text: bool,
    },
    /// Show a single rule by ID
    Show {
        id: String,
        #[arg(long)]
        text: bool,
    },
    /// Add a regex rule
    #[command(
        after_long_help = RULES_ADD_AFTER_LONG_HELP,
        help_template = "\
{about-with-newline}\
{usage-heading} {usage}\
{after-help}\
\n\
{all-args}\
"
    )]
    Add {
        #[arg(long, hide_long_help = true, help = "notify | inform | ignore")]
        action: String,
        #[arg(
            long = "subject-pattern",
            hide_long_help = true,
            help = "regex on subject"
        )]
        subject_pattern: Option<String>,
        #[arg(
            long = "body-pattern",
            hide_long_help = true,
            help = "regex on messages.body_text"
        )]
        body_pattern: Option<String>,
        #[arg(
            long = "from-pattern",
            hide_long_help = true,
            help = "regex on from_address"
        )]
        from_pattern: Option<String>,
        #[arg(
            long = "insert-before",
            hide_long_help = true,
            help = "place new rule before this rule id (default: append)"
        )]
        insert_before: Option<String>,
        #[arg(long, hide_long_help = true, help = "note in rules.json")]
        description: Option<String>,
        #[arg(long, hide_long_help = true, help = "skip inbox preview")]
        no_preview: bool,
        #[arg(long, hide_long_help = true, help = "e.g. 7d")]
        preview_window: Option<String>,
        #[arg(long, hide_long_help = true, help = "text output")]
        text: bool,
    },
    /// Edit an existing rule (action only)
    Edit {
        id: String,
        #[arg(long)]
        action: String,
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
    /// Move a rule to a new position (ordered list precedence)
    #[command(
        after_long_help = RULES_MOVE_AFTER_LONG_HELP,
        help_template = "\
{about-with-newline}\
{usage-heading} {usage}\
{after-help}\
\n\
{all-args}\
"
    )]
    Move {
        /// Rule id to move
        id: String,
        #[arg(long, help = "place this rule before the given rule id")]
        before: Option<String>,
        #[arg(long, help = "place this rule after the given rule id")]
        after: Option<String>,
        #[arg(long)]
        text: bool,
    },
    /// Propose a rule from fuzzy feedback
    Feedback {
        feedback: String,
        #[arg(long)]
        text: bool,
    },
}

#[cfg(test)]
mod draft_cli_tests {
    use super::Cli;
    use super::Commands;
    use super::RulesCmd;
    use clap::Parser;
    use zmail::draft::DraftCmd;

    #[test]
    fn rules_add_parses_subject_pattern() {
        let cli = Cli::try_parse_from([
            "zmail",
            "rules",
            "add",
            "--action",
            "notify",
            "--subject-pattern",
            "(?i)list",
        ])
        .expect("parse");
        match cli.command {
            Commands::Rules { sub } => match sub {
                RulesCmd::Add {
                    action,
                    subject_pattern,
                    body_pattern,
                    from_pattern,
                    ..
                } => {
                    assert_eq!(action, "notify");
                    assert_eq!(subject_pattern.as_deref(), Some("(?i)list"));
                    assert!(body_pattern.is_none());
                    assert!(from_pattern.is_none());
                }
                _ => panic!("expected rules add"),
            },
            _ => panic!("expected rules"),
        }
    }

    #[test]
    fn rules_add_parses_from_pattern() {
        let cli = Cli::try_parse_from([
            "zmail",
            "rules",
            "add",
            "--action",
            "ignore",
            "--from-pattern",
            "@widgets.example",
        ])
        .expect("parse");
        match cli.command {
            Commands::Rules { sub } => match sub {
                RulesCmd::Add {
                    action,
                    from_pattern,
                    subject_pattern,
                    ..
                } => {
                    assert_eq!(action, "ignore");
                    assert_eq!(from_pattern.as_deref(), Some("@widgets.example"));
                    assert!(subject_pattern.is_none());
                }
                _ => panic!("expected rules add"),
            },
            _ => panic!("expected rules"),
        }
    }

    #[test]
    fn rules_add_parses_insert_before() {
        let cli = Cli::try_parse_from([
            "zmail",
            "rules",
            "add",
            "--action",
            "notify",
            "--subject-pattern",
            "(?i)foo",
            "--insert-before",
            "def-otp-subject",
        ])
        .expect("parse");
        match cli.command {
            Commands::Rules { sub } => match sub {
                RulesCmd::Add {
                    insert_before,
                    subject_pattern,
                    ..
                } => {
                    assert_eq!(insert_before.as_deref(), Some("def-otp-subject"));
                    assert_eq!(subject_pattern.as_deref(), Some("(?i)foo"));
                }
                _ => panic!("expected rules add"),
            },
            _ => panic!("expected rules"),
        }
    }

    #[test]
    fn rules_move_parses_before() {
        let cli = Cli::try_parse_from([
            "zmail",
            "rules",
            "move",
            "abc1",
            "--before",
            "def-otp-subject",
        ])
        .expect("parse");
        match cli.command {
            Commands::Rules { sub } => match sub {
                RulesCmd::Move {
                    id, before, after, ..
                } => {
                    assert_eq!(id, "abc1");
                    assert_eq!(before.as_deref(), Some("def-otp-subject"));
                    assert!(after.is_none());
                }
                _ => panic!("expected rules move"),
            },
            _ => panic!("expected rules"),
        }
    }

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
