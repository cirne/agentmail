//! `zmail who` — dynamic contacts from messages (`src/search/who-dynamic.ts` subset).

use rusqlite::Connection;
use serde::Serialize;

use super::contact_rank::contact_rank_simple;
use super::edit_distance::fuzzy_name_token_match;
use super::nicknames::canonical_first_name;
use super::noreply::is_noreply;
use super::phonetics::name_matches_phonetically;

#[derive(Debug, Clone)]
pub struct WhoOptions {
    pub query: String,
    pub limit: usize,
    pub include_noreply: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoPerson {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firstname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lastname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub primary_address: String,
    pub addresses: Vec<String>,
    pub sent_count: i64,
    pub replied_count: i64,
    pub received_count: i64,
    pub mentioned_count: i64,
    pub contact_rank: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_contact: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoResult {
    pub query: String,
    pub people: Vec<WhoPerson>,
}

#[derive(Default, Clone)]
struct Agg {
    display: String,
    display_name: Option<String>,
    sent: i64,
    received: i64,
    last_contact: Option<String>,
}

fn parse_addrs(json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(json).unwrap_or_default()
}

fn first_name_token(display: &str) -> Option<String> {
    let t = display.trim();
    if t.is_empty() {
        return None;
    }
    t.split_whitespace()
        .next()
        .map(|s| s.trim_matches(|c: char| !c.is_alphabetic()).to_lowercase())
}

fn matches_query(addr_lower: &str, display: Option<&str>, q: &str) -> bool {
    let ql = q.trim().to_lowercase();
    if ql.is_empty() {
        return true;
    }
    if addr_lower.contains(&ql) {
        return true;
    }
    if let Some(d) = display {
        let dl = d.to_lowercase();
        if dl.contains(&ql) {
            return true;
        }
        if let Some(first) = first_name_token(d) {
            let canon = canonical_first_name(&first);
            if name_matches_phonetically(&canon, &ql) || fuzzy_name_token_match(&canon, &ql) {
                return true;
            }
            if name_matches_phonetically(&first, &ql) || fuzzy_name_token_match(&first, &ql) {
                return true;
            }
        }
    }
    false
}

/// Build contact list from indexed messages.
pub fn who(conn: &Connection, opts: &WhoOptions) -> rusqlite::Result<WhoResult> {
    let mut stmt = conn.prepare(
        "SELECT from_address, from_name, to_addresses, cc_addresses, date FROM messages",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;

    let mut map: std::collections::HashMap<String, Agg> = std::collections::HashMap::new();

    for r in rows.flatten() {
        let (from_a, from_name, to_j, cc_j, date) = r;
        let from_lower = from_a.to_lowercase();

        {
            let e = map.entry(from_lower.clone()).or_default();
            if e.display.is_empty() {
                e.display = from_a.clone();
            }
            if let Some(ref n) = from_name {
                let n = n.trim();
                if !n.is_empty() {
                    let better = e
                        .display_name
                        .as_ref()
                        .map(|cur| n.len() > cur.len())
                        .unwrap_or(true);
                    if better {
                        e.display_name = Some(n.to_string());
                    }
                }
            }
            e.sent += 1;
            let bump = |lc: &mut Option<String>, d: &str| {
                if lc.as_ref().map(|x| d > x.as_str()).unwrap_or(true) {
                    *lc = Some(d.to_string());
                }
            };
            bump(&mut e.last_contact, &date);
        }

        for a in parse_addrs(&to_j)
            .into_iter()
            .chain(parse_addrs(&cc_j))
        {
            let al = a.to_lowercase();
            let e = map.entry(al.clone()).or_default();
            if e.display.is_empty() {
                e.display = a;
            }
            e.received += 1;
            let bump = |lc: &mut Option<String>, d: &str| {
                if lc.as_ref().map(|x| d > x.as_str()).unwrap_or(true) {
                    *lc = Some(d.to_string());
                }
            };
            bump(&mut e.last_contact, &date);
        }
    }

    let q = opts.query.trim().to_lowercase();
    let mut people: Vec<WhoPerson> = Vec::new();

    for (addr_lower, agg) in map {
        if !opts.include_noreply && is_noreply(&agg.display) {
            continue;
        }
        if !matches_query(&addr_lower, agg.display_name.as_deref(), &q) {
            continue;
        }
        let rank = contact_rank_simple(agg.sent, agg.received);
        let (firstname, lastname, name) = if let Some(ref dn) = agg.display_name {
            let parts: Vec<&str> = dn.split_whitespace().collect();
            if parts.len() >= 2 {
                (
                    Some(parts[0].to_string()),
                    Some(parts[parts.len() - 1].to_string()),
                    None,
                )
            } else {
                (None, None, Some(dn.clone()))
            }
        } else {
            (None, None, None)
        };
        people.push(WhoPerson {
            firstname,
            lastname,
            name,
            primary_address: agg.display.clone(),
            addresses: vec![agg.display],
            sent_count: agg.sent,
            replied_count: 0,
            received_count: agg.received,
            mentioned_count: 0,
            contact_rank: rank,
            last_contact: agg.last_contact,
        });
    }

    people.sort_by(|a, b| {
        b.contact_rank
            .partial_cmp(&a.contact_rank)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.last_contact
                    .cmp(&a.last_contact)
                    .then_with(|| a.primary_address.cmp(&b.primary_address))
            })
    });

    let lim = opts.limit.max(1);
    people.truncate(lim);

    Ok(WhoResult {
        query: opts.query.clone(),
        people,
    })
}
