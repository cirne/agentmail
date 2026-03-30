//! zmail library — Rust port (see repo `rust/` during migration).

pub mod ask;
pub mod ask_stub;
pub mod attachments;
pub mod config;
pub mod db;
pub mod inbox_window;
pub mod mail_read;
pub mod mcp;
pub mod rebuild_index;
pub mod refresh;
pub mod search;
pub mod send;
pub mod setup;
pub mod status;
pub mod sync;
pub mod thread_view;

pub use ask::{run_ask, RunAskError, RunAskOptions};
pub use ask_stub::{
    ask_rejects_old_explicit_year, ask_rejects_stale_date_range, draft_rewrite_stub,
};
pub use attachments::{
    extract_and_cache, extract_attachment, list_attachments_for_message, read_stored_file,
    AttachmentListRow,
};
pub use config::{
    load_config, resolve_openai_api_key, resolve_smtp_settings, Config, ConfigJson,
    LoadConfigOptions, ResolvedSmtp,
};
pub use db::message_persist::{fts_match_count, persist_attachments_from_parsed, persist_message};
pub use db::{
    apply_schema, journal_mode, list_user_tables, open_file, open_memory, DbError, SCHEMA_VERSION,
};
pub use inbox_window::parse_inbox_window_to_iso_cutoff;
pub use mail_read::{read_message_bytes, resolve_raw_path};
pub use mcp::{handle_request_line, tool_schemas_stable, JsonRpcRequest, TOOL_NAMES};
pub use rebuild_index::{rebuild_from_maildir, rebuild_from_maildir_sequential};
pub use refresh::{
    build_refresh_json_value, load_refresh_new_mail, print_refresh_text, RefreshPreviewRow,
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
    extract_threading_headers, filter_recipients_send_test, list_drafts, plan_send, read_draft,
    resolve_smtp_for_imap_host, write_draft, DraftFile, DraftMeta, SendPlan, SendTestMode,
};
pub use setup::{
    collect_stats, resolve_setup_email, resolve_setup_password, write_setup, SetupArgs, StatsJson,
};
pub use status::{format_time_ago, get_status, print_status_text, StatusData};
pub use sync::{
    acquire_lock, connect_imap_session, filter_uids_after, forward_uid_range, is_process_alive,
    is_sync_lock_held, oldest_message_date_for_folder, parse_raw_message, parse_since_to_date,
    release_lock, resolve_sync_mailbox, resolve_sync_since_ymd, run_sync,
    run_sync_with_parallel_imap_connect, same_calendar_day, should_early_exit_forward,
    sync_log_path, write_maildir_message, FakeImapTransport, FetchedMessage, ImapStatusData,
    LockResult, MaildirWrite, ParsedAttachment, ParsedMessage, RealImapTransport, RunSyncError,
    SyncDirection, SyncFileLogger, SyncImapTransport, SyncLockRow, SyncOptions, SyncResult,
};
pub use thread_view::{list_thread_messages, ThreadMessageRow};
