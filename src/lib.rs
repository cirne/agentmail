//! zmail library — Rust CLI/MCP implementation (workspace root).

pub mod ask;
pub mod ask_stub;
pub mod attachments;
pub mod config;
pub mod db;
pub mod draft;
pub mod ids;
pub mod inbox;
pub mod inbox_window;
pub mod mail_category;
pub mod mail_read;
pub mod mcp;
pub mod rebuild_index;
pub mod refresh;
pub mod rules;
pub mod search;
pub mod send;
pub mod setup;
pub mod status;
pub mod sync;
pub mod thread_view;
pub mod wizard;

pub use ask::{run_ask, RunAskError, RunAskOptions};
pub use ask_stub::{
    ask_rejects_old_explicit_year, ask_rejects_stale_date_range, draft_rewrite_stub,
};
pub use attachments::{
    extract_and_cache, extract_attachment, list_attachments_for_message, read_attachment_text,
    read_stored_file, AttachmentListRow,
};
pub use config::{
    load_config, resolve_openai_api_key, resolve_smtp_settings, Config, ConfigJson,
    LoadConfigOptions, ResolvedSmtp,
};
pub use db::message_persist::{fts_match_count, persist_attachments_from_parsed, persist_message};
pub use db::{
    apply_schema, journal_mode, list_user_tables, open_file, open_memory, DbError, SCHEMA_VERSION,
};
pub use ids::{
    message_id_lookup_keys, normalize_message_id, resolve_message_id,
    resolve_message_id_and_raw_path, resolve_message_id_thread_and_raw_path, resolve_thread_id,
};
pub use inbox::{
    dismiss_message, inbox_candidate_prefetch_limit, record_inbox_scan, run_inbox_scan,
    InboxBatchClassifier, InboxCandidate, InboxNotablePick, InboxOwnerContext, InboxSurfaceMode,
    MockInboxClassifier, OpenAiInboxClassifier, RunInboxScanError, RunInboxScanOptions,
    RunInboxScanResult,
};
pub use inbox_window::parse_inbox_window_to_iso_cutoff;
pub use mail_category::{
    default_category_filter_sql, is_default_excluded_category, label_to_category,
    parse_category_list, DEFAULT_EXCLUDED_CATEGORIES,
};
pub use mail_read::{
    format_read_message_text, read_message_bytes, read_message_bytes_with_thread, resolve_raw_path,
    ReadMessageJson,
};
pub use mcp::{handle_request_line, tool_schemas_stable, JsonRpcRequest, TOOL_NAMES};
pub use rebuild_index::{rebuild_from_maildir, rebuild_from_maildir_sequential};
pub use refresh::{
    build_check_json, build_refresh_json_value, build_refresh_json_value_with_extras,
    build_review_json, load_refresh_new_mail, print_check_text, print_refresh_text,
    print_review_text, InboxDispositionCounts, RefreshPreviewRow,
};
pub use rules::{
    add_context, add_rule, build_inbox_rules_prompt, edit_rule, load_rules_file, parse_rule_action,
    propose_rule_from_feedback, remove_context, remove_rule, rules_fingerprint, rules_path,
    ContextEntry, ProposedRule, RuleActionKind, RuleFeedbackProposal, RulesError, RulesFile,
    UserRule,
};
pub use search::{
    canonical_first_name, contact_rank_simple, convert_to_or_query, escape_fts5_query,
    extract_signature_data, fuzzy_name_token_match, infer_name_from_address, is_noreply,
    name_matches_phonetically, normalize_address, parse_search_query, parse_signature_block,
    resolve_search_json_format, search_result_to_slim_json_row, search_with_meta,
    sort_rows_by_sender_contact_rank, who, ExtractedSignature, ParsedSearchQuery, SearchJsonFormat,
    SearchOptions, SearchResult, SearchResultFormatPreference, SearchResultSet, SearchTimings,
    WhoOptions, WhoPerson, WhoResult, SEARCH_AUTO_SLIM_THRESHOLD,
};
pub use send::{
    extract_threading_headers, filter_recipients_send_test, list_drafts,
    load_threading_from_source_message, plan_send, read_draft, resolve_smtp_for_imap_host,
    send_draft_by_id, send_simple_message, split_address_list, verify_smtp_credentials,
    write_draft, DraftFile, DraftMeta, SendPlan, SendResult, SendSimpleFields, SendTestMode,
};
pub use setup::{
    clean_zmail_home, collect_stats, derive_imap_settings, load_existing_env_secrets,
    load_existing_wizard_config, mask_secret, parse_dotenv_secrets, resolve_setup_email,
    resolve_setup_password, validate_imap_credentials, validate_openai_key, write_setup,
    write_zmail_config_and_env, DerivedImap, ExistingEnvSecrets, ExistingWizardConfig, SetupArgs,
    StatsJson, WriteZmailParams,
};
pub use status::{
    format_time_ago, get_imap_server_status, get_status, print_status_text, ImapServerComparison,
    StatusData,
};
pub use sync::{
    acquire_lock, connect_imap_session, filter_uids_after, forward_uid_range, is_process_alive,
    is_sync_lock_held, oldest_message_date_for_folder, parse_index_message, parse_raw_message,
    parse_raw_message_with_options, parse_read_full, parse_since_to_date, release_lock,
    resolve_sync_mailbox, resolve_sync_since_ymd, run_sync, run_sync_with_parallel_imap_connect,
    same_calendar_day, should_early_exit_forward, spawn_sync_background_detached, sync_log_path,
    write_maildir_message, FakeImapTransport, FetchedMessage, ImapStatusData, LockResult,
    MailboxEntry, MaildirWrite, ParseMessageOptions, ParsedAttachment, ParsedMessage, ReadForCli,
    RealImapTransport, RunSyncError, SyncDirection, SyncFileLogger, SyncImapTransport, SyncLockRow,
    SyncOptions, SyncResult,
};
pub use thread_view::{list_thread_messages, ThreadMessageRow};
pub use wizard::{run_wizard, WizardOptions};
