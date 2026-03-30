//! FTS5 search (mirrors `src/search/index.ts`).

mod contact_rank;
mod edit_distance;
mod engine;
mod escape;
mod filter;
mod infer_name;
mod json_format;
mod nicknames;
mod normalize;
mod noreply;
mod phonetics;
mod query_parse;
mod signature;
mod types;
pub mod who;

pub use contact_rank::contact_rank_simple;
pub use engine::search_with_meta;
pub use escape::{convert_to_or_query, escape_fts5_query};
pub use infer_name::infer_name_from_address;
pub use json_format::{
    resolve_search_json_format, search_result_to_slim_json_row, SearchJsonFormat,
    SearchResultFormatPreference, SEARCH_AUTO_SLIM_THRESHOLD,
};
pub use nicknames::canonical_first_name;
pub use normalize::normalize_address;
pub use noreply::is_noreply;
pub use phonetics::name_matches_phonetically;
pub use query_parse::{parse_search_query, ParsedSearchQuery};
pub use signature::{extract_signature_data, parse_signature_block, ExtractedSignature};
pub use types::{SearchOptions, SearchResult, SearchResultSet, SearchTimings};
pub use who::{who, WhoOptions, WhoPerson, WhoResult};
pub use edit_distance::fuzzy_name_token_match;
