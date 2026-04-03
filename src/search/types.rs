//! Public search types (JSON shape aligns with TS `SearchResult` / `SearchResultSet`).

use serde::Serialize;

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub query: Option<String>,
    pub limit: Option<usize>,
    pub offset: usize,
    pub from_address: Option<String>,
    pub to_address: Option<String>,
    pub subject: Option<String>,
    pub after_date: Option<String>,
    pub before_date: Option<String>,
    pub filter_or: bool,
    pub include_all: bool,
    pub categories: Vec<String>,
    pub owner_address: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    #[serde(serialize_with = "crate::ids::serialize_string_id_for_json")]
    pub message_id: String,
    #[serde(serialize_with = "crate::ids::serialize_string_id_for_json")]
    pub thread_id: String,
    pub from_address: String,
    pub from_name: Option<String>,
    pub subject: String,
    pub date: String,
    pub snippet: String,
    pub body_preview: String,
    pub rank: f64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTimings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fts_ms: Option<u64>,
    pub total_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultSet {
    pub results: Vec<SearchResult>,
    pub timings: SearchTimings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_matched: Option<i64>,
}
