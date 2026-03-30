//! Owner-centric contact stats + search rerank (`src/search/owner-contact-stats.ts`, `contact-rank.ts`).

use rusqlite::Connection;

use super::normalize::normalize_address;
use super::noreply::is_noreply;
use super::types::SearchResult;

const WEIGHT_SENT: f64 = 2.2;
const WEIGHT_REPLIED: f64 = 1.0;
const WEIGHT_RECEIVED: f64 = 1.4;
const WEIGHT_MENTIONED: f64 = 0.35;
const LOG_CAP: f64 = 48.0;
const LAMBDA: f64 = 2.5;
const EPS: f64 = 1.0;
/// Same as TS `SEARCH_CONTACT_RANK_BOOST_ALPHA`
pub const SEARCH_CONTACT_RANK_BOOST_ALPHA: f64 = 0.12;

#[derive(Debug, Clone, Default)]
struct ContactFields {
    sent_count: i64,
    replied_count: i64,
    received_count: i64,
    mentioned_count: i64,
}

fn capped_log1p(n: f64) -> f64 {
    (n.max(0.0) + 1.0).ln().min(LOG_CAP)
}

fn received_inbound_multiplier(f: &ContactFields) -> f64 {
    let outbound = (f.sent_count + f.replied_count).max(0) as f64;
    let inbound_log = capped_log1p(f.received_count as f64);
    let numer = outbound + EPS;
    let denom = numer + LAMBDA * inbound_log;
    if denom <= 0.0 {
        0.0
    } else {
        numer / denom
    }
}

fn compute_contact_rank(f: &ContactFields) -> f64 {
    let recv_mult = received_inbound_multiplier(f);
    WEIGHT_SENT * capped_log1p(f.sent_count as f64)
        + WEIGHT_REPLIED * capped_log1p(f.replied_count as f64)
        + WEIGHT_RECEIVED * recv_mult * capped_log1p(f.received_count as f64)
        + WEIGHT_MENTIONED * capped_log1p(f.mentioned_count as f64)
}

/// `who` list ordering when only sent/received totals are known.
pub fn contact_rank_simple(sent: i64, received: i64) -> f64 {
    compute_contact_rank(&ContactFields {
        sent_count: sent,
        replied_count: 0,
        received_count: received,
        mentioned_count: 0,
    })
}

fn parse_json_addresses(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn owner_sees_message(owner_norm: &str, to_raw: &[String], cc_raw: &[String]) -> bool {
    to_raw
        .iter()
        .any(|a| normalize_address(a) == owner_norm)
        || cc_raw
            .iter()
            .any(|a| normalize_address(a) == owner_norm)
}

#[derive(Clone)]
struct MsgRow {
    thread_id: String,
    from_address: String,
    to_addresses: String,
    cc_addresses: String,
}

fn load_messages_for_owner_stats(
    conn: &Connection,
    owner_norm: &str,
    candidates: &std::collections::HashSet<String>,
) -> rusqlite::Result<Vec<MsgRow>> {
    let mut stmt = conn.prepare(
        "SELECT thread_id, date, from_address, to_addresses, cc_addresses FROM messages ORDER BY date ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(MsgRow {
                thread_id: row.get(0)?,
                from_address: row.get(2)?,
                to_addresses: row.get(3)?,
                cc_addresses: row.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect::<Vec<_>>();

    let mut want = std::collections::HashSet::new();
    want.insert(owner_norm.to_string());
    want.extend(candidates.iter().cloned());

    Ok(rows
        .into_iter()
        .filter(|m| {
            let from_n = normalize_address(&m.from_address);
            if want.contains(&from_n) {
                return true;
            }
            let to = parse_json_addresses(&m.to_addresses);
            let cc = parse_json_addresses(&m.cc_addresses);
            for a in &to {
                if want.contains(&normalize_address(a)) {
                    return true;
                }
            }
            for a in &cc {
                if want.contains(&normalize_address(a)) {
                    return true;
                }
            }
            false
        })
        .collect())
}

fn compute_owner_centric_stats(
    conn: &Connection,
    owner_address: &str,
    candidate_norms: &std::collections::HashSet<String>,
) -> rusqlite::Result<std::collections::HashMap<String, ContactFields>> {
    let owner_norm = normalize_address(owner_address);
    let mut candidates = std::collections::HashSet::new();
    for a in candidate_norms {
        let n = normalize_address(a);
        if n != owner_norm {
            candidates.insert(n);
        }
    }

    let mut stats: std::collections::HashMap<String, ContactFields> = std::collections::HashMap::new();
    for c in &candidates {
        stats.insert(c.clone(), ContactFields::default());
    }

    if candidates.is_empty() {
        return Ok(stats);
    }

    let messages = load_messages_for_owner_stats(conn, &owner_norm, &candidates)?;
    let mut seen_owner_to_peer_in_thread = std::collections::HashSet::<String>::new();

    for m in messages {
        let from_n = normalize_address(&m.from_address);
        let to_raw = parse_json_addresses(&m.to_addresses);
        let cc_raw = parse_json_addresses(&m.cc_addresses);
        let to_norm: Vec<String> = to_raw.iter().map(|x| normalize_address(x)).collect();
        let cc_norm: Vec<String> = cc_raw.iter().map(|x| normalize_address(x)).collect();

        if candidates.contains(&from_n) && owner_sees_message(&owner_norm, &to_raw, &cc_raw) {
            if !is_noreply(&m.from_address) {
                if let Some(s) = stats.get_mut(&from_n) {
                    s.received_count += 1;
                }
            }
        }

        for peer in &cc_norm {
            if peer == &owner_norm {
                continue;
            }
            if !candidates.contains(peer) {
                continue;
            }
            if from_n == *peer {
                continue;
            }
            if is_noreply(peer) {
                continue;
            }
            if let Some(s) = stats.get_mut(peer) {
                s.mentioned_count += 1;
            }
        }

        if from_n == owner_norm {
            let mut recipients = std::collections::HashSet::new();
            for p in &to_norm {
                if p != &owner_norm {
                    recipients.insert(p.clone());
                }
            }
            for p in &cc_norm {
                if p != &owner_norm {
                    recipients.insert(p.clone());
                }
            }
            for peer in recipients {
                if !candidates.contains(&peer) {
                    continue;
                }
                if is_noreply(&peer) {
                    continue;
                }
                let key = format!("{}\0{}", m.thread_id, peer);
                if let Some(s) = stats.get_mut(&peer) {
                    if !seen_owner_to_peer_in_thread.contains(&key) {
                        seen_owner_to_peer_in_thread.insert(key);
                        s.sent_count += 1;
                    } else {
                        s.replied_count += 1;
                    }
                }
            }
        }

    }

    Ok(stats)
}

pub fn contact_rank_map_for_addresses(
    conn: &Connection,
    owner_address: &str,
    addresses: &[String],
) -> rusqlite::Result<std::collections::HashMap<String, f64>> {
    let mut norms = std::collections::HashSet::new();
    for a in addresses {
        norms.insert(normalize_address(a));
    }
    let stats = compute_owner_centric_stats(conn, owner_address, &norms)?;
    let mut out = std::collections::HashMap::new();
    for (addr, f) in stats {
        out.insert(addr, compute_contact_rank(&f));
    }
    Ok(out)
}

/// Sort rows by sender contact rank (desc), then date (desc). No-op if `owner_address` is empty.
pub fn sort_rows_by_sender_contact_rank<T: Clone>(
    conn: &Connection,
    owner_address: Option<&str>,
    rows: Vec<T>,
    from_address: impl Fn(&T) -> &str,
    date: impl Fn(&T) -> &str,
) -> rusqlite::Result<Vec<T>> {
    let Some(owner) = owner_address.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(rows);
    };
    if rows.is_empty() {
        return Ok(rows);
    }
    let norms: std::collections::HashSet<String> =
        rows.iter().map(|r| normalize_address(from_address(r))).collect();
    let norms_vec: Vec<String> = norms.into_iter().collect();
    let rank_map = contact_rank_map_for_addresses(conn, owner, &norms_vec)?;
    let mut out: Vec<(T, f64, String)> = rows
        .into_iter()
        .map(|r| {
            let fa = normalize_address(from_address(&r));
            let rank = *rank_map.get(&fa).unwrap_or(&0.0);
            let d = date(&r).to_string();
            (r, rank, d)
        })
        .collect();
    out.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.2.cmp(&a.2))
    });
    Ok(out.into_iter().map(|(r, _, _)| r).collect())
}

#[derive(Debug, Clone)]
pub struct RankedSearchRow {
    pub result: SearchResult,
    pub combined_rank: f64,
}

/// Participant contact-rank boost (OPP-012). Strips `combined_rank` from output rows.
pub fn apply_contact_rank_rerank(
    conn: &Connection,
    owner_address: Option<&str>,
    rows: Vec<RankedSearchRow>,
) -> rusqlite::Result<Vec<SearchResult>> {
    let Some(owner) = owner_address.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(rows.into_iter().map(|r| r.result).collect());
    };

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let owner_norm = normalize_address(owner);
    let ids: Vec<String> = rows
        .iter()
        .map(|r| r.result.message_id.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT message_id, from_address, to_addresses, cc_addresses FROM messages WHERE message_id IN ({placeholders})"
    );

    let mut stmt = conn.prepare(&sql)?;
    let meta_rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;

    let mut by_id = std::collections::HashMap::new();
    for r in meta_rows.flatten() {
        by_id.insert(r.0, (r.1, r.2, r.3));
    }

    let mut all_addresses = std::collections::HashSet::new();
    for (_mid, (from_a, to_j, cc_j)) in &by_id {
        all_addresses.insert(normalize_address(from_a));
        for a in parse_json_addresses(to_j) {
            all_addresses.insert(normalize_address(&a));
        }
        for a in parse_json_addresses(cc_j) {
            all_addresses.insert(normalize_address(&a));
        }
    }
    all_addresses.remove(&owner_norm);

    let addr_vec: Vec<String> = all_addresses.into_iter().collect();
    let rank_map = contact_rank_map_for_addresses(conn, owner, &addr_vec)?;

    let mut scored: Vec<(RankedSearchRow, f64)> = rows
        .into_iter()
        .map(|r| {
            let mut max_rank = 0.0_f64;
            if let Some((from_a, to_j, cc_j)) = by_id.get(&r.result.message_id) {
                let mut parts = std::collections::HashSet::new();
                parts.insert(normalize_address(from_a));
                for a in parse_json_addresses(to_j) {
                    parts.insert(normalize_address(&a));
                }
                for a in parse_json_addresses(cc_j) {
                    parts.insert(normalize_address(&a));
                }
                parts.remove(&owner_norm);
                for p in parts {
                    max_rank = max_rank.max(*rank_map.get(&p).unwrap_or(&0.0));
                }
            }
            let final_rank = r.combined_rank - SEARCH_CONTACT_RANK_BOOST_ALPHA * max_rank;
            (r, final_rank)
        })
        .collect();

    scored.sort_by(|a, b| {
        a.1.partial_cmp(&b.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.result.date.cmp(&a.0.result.date))
    });

    Ok(scored.into_iter().map(|(r, _)| r.result).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contact_rank_more_sent_orders_higher() {
        let a = contact_rank_simple(10, 0);
        let b = contact_rank_simple(5, 0);
        assert!(a > b);
    }

    #[test]
    fn contact_rank_non_negative() {
        assert!(contact_rank_simple(0, 0) >= 0.0);
        assert!(contact_rank_simple(3, 100) >= 0.0);
    }
}
