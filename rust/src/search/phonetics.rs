//! Phonetic name match (double metaphone via `rphonetic`).

use rphonetic::{DoubleMetaphone, Encoder};

fn primary_code(s: &str) -> String {
    DoubleMetaphone::default().encode(s)
}

/// True if tokens share the same double-metaphone primary (e.g. Jon / John).
pub fn name_matches_phonetically(name_token: &str, query: &str) -> bool {
    let n = name_token.trim();
    let q = query.trim();
    if n.is_empty() || q.is_empty() {
        return false;
    }
    let pn = primary_code(n);
    let pq = primary_code(q);
    !pn.is_empty() && pn == pq
}
