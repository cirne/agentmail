//! `search_with_meta` — FTS + filter-only paths + contact-rank rerank.

use rusqlite::{params_from_iter, types::Value, Connection};

use super::contact_rank::{apply_contact_rank_rerank, RankedSearchRow};
use super::escape::convert_to_or_query;
use super::filter::{build_filter_clause, build_where_sql};
use super::query_parse::parse_search_query;
use super::types::{SearchOptions, SearchResult, SearchResultSet, SearchTimings};

fn date_recency_boost_days_ago(days_ago: f64) -> f64 {
    let d = days_ago.max(0.0);
    if d <= 1.0 {
        10.0
    } else if d <= 7.0 {
        8.0 - d * 0.5
    } else if d <= 30.0 {
        4.5 - (d - 7.0) * 0.1
    } else if d <= 90.0 {
        1.2 - (d - 30.0) * 0.01
    } else {
        0.6 - (d - 90.0) * 0.001
    }
}

fn filter_only_combined_rank(iso_date: &str) -> f64 {
    let normalized = iso_date.trim().replace(' ', "T");
    let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&normalized) else {
        return 0.0;
    };
    let dt = dt.with_timezone(&chrono::Utc);
    let days_ago = (chrono::Utc::now() - dt).num_milliseconds() as f64 / 86400000.0;
    -date_recency_boost_days_ago(days_ago)
}

fn merge_effective_opts(opts: &SearchOptions) -> SearchOptions {
    let mut e = opts.clone();
    if let Some(ref q) = opts.query {
        if !q.trim().is_empty() {
            let p = parse_search_query(q);
            if p.from_address.is_some() && e.from_address.is_none() {
                e.from_address = p.from_address;
            }
            if p.to_address.is_some() && e.to_address.is_none() {
                e.to_address = p.to_address;
            }
            if p.subject.is_some() && e.subject.is_none() {
                e.subject = p.subject;
            }
            if p.after_date.is_some() && e.after_date.is_none() {
                e.after_date = p.after_date;
            }
            if p.before_date.is_some() && e.before_date.is_none() {
                e.before_date = p.before_date;
            }
            if let Some(fo) = p.filter_or {
                e.filter_or = fo;
            }
            e.query = Some(p.query);
        }
    }
    e
}

#[allow(clippy::too_many_arguments)]
fn row_from_cols(
    message_id: String,
    thread_id: String,
    from_address: String,
    from_name: Option<String>,
    subject: String,
    date: String,
    snippet: String,
    body_preview: String,
    rank: f64,
) -> SearchResult {
    SearchResult {
        message_id,
        thread_id,
        from_address,
        from_name,
        subject,
        date,
        snippet,
        body_preview,
        rank,
    }
}

fn filter_only_search(
    conn: &Connection,
    opts: &SearchOptions,
) -> rusqlite::Result<(Vec<RankedSearchRow>, i64)> {
    let fc = build_filter_clause(opts, false);
    let where_sql = build_where_sql(&fc);
    let where_clause = if where_sql.is_empty() {
        String::new()
    } else {
        format!("WHERE {where_sql}")
    };

    let count_sql = format!("SELECT COUNT(*) FROM messages m {where_clause}");
    let count_vals: Vec<Value> = fc.params.iter().cloned().map(Value::Text).collect();
    let total: i64 = if count_vals.is_empty() {
        conn.query_row(&count_sql, [], |r| r.get(0))?
    } else {
        conn.query_row(&count_sql, params_from_iter(count_vals.iter()), |r| {
            r.get(0)
        })?
    };

    let limit = opts.limit.unwrap_or(50);
    let offset = opts.offset;
    let sql_limit = limit + offset + 50;

    let body_prev = "COALESCE(TRIM(SUBSTR(m.body_text, 1, 300)), '') || (CASE WHEN LENGTH(TRIM(m.body_text)) > 300 THEN '…' ELSE '' END)";
    let sql = format!(
        "SELECT m.message_id, m.thread_id, m.from_address, m.from_name, m.subject, m.date,
                COALESCE(TRIM(SUBSTR(m.body_text, 1, 200)), '') || (CASE WHEN LENGTH(m.body_text) > 200 THEN '…' ELSE '' END),
                {body_prev}
         FROM messages m {where_clause}
         ORDER BY m.date DESC
         LIMIT ?"
    );

    let mut vals: Vec<Value> = fc.params.iter().cloned().map(Value::Text).collect();
    vals.push(Value::Integer(sql_limit as i64));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(vals.iter()), |row| {
        Ok(row_from_cols(
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get::<_, String>(6)?,
            row.get(7)?,
            0.0,
        ))
    })?;

    let mut vec: Vec<RankedSearchRow> = rows
        .filter_map(|r| r.ok())
        .map(|r| {
            let cr = filter_only_combined_rank(&r.date);
            RankedSearchRow {
                result: r,
                combined_rank: cr,
            }
        })
        .collect();
    vec.sort_by(|a, b| {
        a.combined_rank
            .partial_cmp(&b.combined_rank)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let results: Vec<RankedSearchRow> = vec.into_iter().skip(offset).take(limit).collect();
    Ok((results, total))
}

fn fts_search(
    conn: &Connection,
    opts: &SearchOptions,
) -> rusqlite::Result<(Vec<RankedSearchRow>, i64)> {
    let q = opts.query.as_deref().unwrap_or("").trim();
    if q.is_empty() {
        return Ok((Vec::new(), 0));
    }
    let escaped = convert_to_or_query(q);
    let fc = build_filter_clause(opts, true);
    let where_sql = build_where_sql(&fc);
    let where_clause = if where_sql.is_empty() {
        String::new()
    } else {
        format!("WHERE {where_sql}")
    };

    let mut count_vals: Vec<Value> = vec![Value::Text(escaped.clone())];
    count_vals.extend(fc.params.iter().cloned().map(Value::Text));

    let count_sql = format!(
        "SELECT COUNT(*) FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid {where_clause}"
    );
    let total: i64 = conn.query_row(&count_sql, params_from_iter(count_vals.iter()), |r| {
        r.get(0)
    })?;

    let limit = opts.limit.unwrap_or(50);
    let offset = opts.offset;
    let sql_limit = limit + offset + 50;

    let days_ago = "julianday('now') - julianday(m.date)";
    let date_boost = format!(
        "CASE 
        WHEN {days_ago} <= 1 THEN 10.0
        WHEN {days_ago} <= 7 THEN 8.0 - ({days_ago} * 0.5)
        WHEN {days_ago} <= 30 THEN 4.5 - (({days_ago} - 7) * 0.1)
        WHEN {days_ago} <= 90 THEN 1.2 - (({days_ago} - 30) * 0.01)
        ELSE 0.6 - (({days_ago} - 90) * 0.001)
        END"
    );
    let body_prev = "COALESCE(TRIM(SUBSTR(m.body_text, 1, 300)), '') || (CASE WHEN LENGTH(TRIM(m.body_text)) > 300 THEN '…' ELSE '' END)";

    let sql = format!(
        "SELECT m.message_id, m.thread_id, m.from_address, m.from_name, m.subject, m.date,
                snippet(messages_fts, 2, '<b>', '</b>', '…', 20),
                {body_prev},
                rank,
                (rank - ({date_boost})) AS combined_rank
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         {where_clause}
         ORDER BY combined_rank ASC, m.date DESC
         LIMIT ?"
    );

    let mut vals: Vec<Value> = vec![Value::Text(escaped)];
    vals.extend(fc.params.iter().cloned().map(Value::Text));
    vals.push(Value::Integer(sql_limit as i64));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(vals.iter()), |row| {
        let snip: Option<String> = row.get(6)?;
        let rank_v: f64 = row.get(8)?;
        let cr: f64 = row.get(9)?;
        Ok(RankedSearchRow {
            result: row_from_cols(
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                snip.unwrap_or_default(),
                row.get(7)?,
                rank_v,
            ),
            combined_rank: cr,
        })
    })?;

    let mut vec: Vec<RankedSearchRow> = rows.filter_map(|r| r.ok()).collect();
    vec.sort_by(|a, b| {
        a.combined_rank
            .partial_cmp(&b.combined_rank)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.result.date.cmp(&a.result.date))
    });
    let results: Vec<RankedSearchRow> = vec.into_iter().skip(offset).take(limit).collect();
    Ok((results, total))
}

/// Main entry (sync API).
pub fn search_with_meta(
    conn: &Connection,
    opts: &SearchOptions,
) -> rusqlite::Result<SearchResultSet> {
    let started = std::time::Instant::now();
    let eff = merge_effective_opts(opts);
    let q = eff.query.as_deref().unwrap_or("").trim();

    if q.is_empty() {
        let (ranked, total) = filter_only_search(conn, &eff)?;
        let results = apply_contact_rank_rerank(conn, eff.owner_address.as_deref(), ranked)?;
        return Ok(SearchResultSet {
            results,
            timings: SearchTimings {
                fts_ms: None,
                total_ms: started.elapsed().as_millis() as u64,
            },
            total_matched: Some(total),
        });
    }

    let t0 = std::time::Instant::now();
    let (ranked, total) = fts_search(conn, &eff)?;
    let results = apply_contact_rank_rerank(conn, eff.owner_address.as_deref(), ranked)?;
    let fts_ms = t0.elapsed().as_millis() as u64;

    Ok(SearchResultSet {
        results,
        timings: SearchTimings {
            fts_ms: Some(fts_ms),
            total_ms: started.elapsed().as_millis() as u64,
        },
        total_matched: Some(total),
    })
}
