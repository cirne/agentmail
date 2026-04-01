//! Sync / search status from DB — mirrors `src/lib/status.ts`.

use rusqlite::{Connection, OptionalExtension};

use crate::config::Config;
use crate::sync::{connect_imap_session, RealImapTransport, SyncImapTransport};

const STATUS_LABEL_WIDTH: usize = 13;

#[derive(Debug, Clone)]
pub struct TimeAgo {
    pub human: String,
    pub duration: String,
}

pub fn format_time_ago(iso_date: Option<&str>) -> Option<TimeAgo> {
    let iso = iso_date?;
    let date = if iso.contains('Z') || iso.contains('+') {
        chrono::DateTime::parse_from_rfc3339(iso)
            .ok()
            .map(|d| d.with_timezone(&chrono::Utc))
    } else {
        let normalized = format!("{}Z", iso.replace(' ', "T"));
        chrono::DateTime::parse_from_rfc3339(&normalized)
            .ok()
            .map(|d| d.with_timezone(&chrono::Utc))
    }?;

    let now = chrono::Utc::now();
    let ms = (now - date).num_milliseconds();
    if ms < 0 {
        return None;
    }
    let sec = ms / 1000;
    let min = sec / 60;
    let hr = min / 60;
    let day = hr / 24;
    let week = day / 7;
    let month = day / 30;
    let year = day / 365;

    let (human, duration) = if sec < 60 {
        ("just now".into(), "PT0S".into())
    } else if min < 60 {
        (
            format!(
                "{} {} ago",
                min,
                if min == 1 { "minute" } else { "minutes" }
            ),
            format!("PT{min}M"),
        )
    } else if hr < 24 {
        (
            format!("{} {} ago", hr, if hr == 1 { "hour" } else { "hours" }),
            format!("PT{hr}H"),
        )
    } else if day < 7 {
        (
            format!("{} {} ago", day, if day == 1 { "day" } else { "days" }),
            format!("P{day}D"),
        )
    } else if week < 4 {
        (
            format!("{} {} ago", week, if week == 1 { "week" } else { "weeks" }),
            format!("P{week}W"),
        )
    } else if month < 12 {
        (
            format!(
                "{} {} ago",
                month,
                if month == 1 { "month" } else { "months" }
            ),
            format!("P{}D", month * 30),
        )
    } else {
        (
            format!("{} {} ago", year, if year == 1 { "year" } else { "years" }),
            format!("P{year}Y"),
        )
    };

    Some(TimeAgo { human, duration })
}

#[derive(Debug, Clone)]
pub struct SyncStatus {
    pub is_running: bool,
    pub last_sync_at: Option<String>,
    pub total_messages: i64,
    pub earliest_synced_date: Option<String>,
    pub latest_synced_date: Option<String>,
    pub target_start_date: Option<String>,
    pub sync_start_earliest_date: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StatusData {
    pub sync: SyncStatus,
    pub fts_ready: i64,
    pub date_range: Option<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct ImapStatusSide {
    pub messages: i64,
    pub uid_next: Option<u32>,
    pub uid_validity: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct ImapStatusCoverage {
    pub days_ago: i64,
    pub years_ago: String,
    pub earliest_date: String,
}

#[derive(Debug, Clone)]
pub struct ImapServerComparison {
    pub server: ImapStatusSide,
    pub local: ImapStatusSide,
    pub missing: Option<i64>,
    pub missing_uid_range: Option<(u32, u32)>,
    pub uid_validity_mismatch: bool,
    pub coverage: Option<ImapStatusCoverage>,
}

fn build_imap_server_comparison(
    status: &StatusData,
    server_messages: Option<u32>,
    server_uid_next: Option<u32>,
    server_uid_validity: Option<u32>,
    local_last_uid: Option<u32>,
    local_uid_validity: Option<u32>,
) -> ImapServerComparison {
    let uid_validity_mismatch = match (server_uid_validity, local_uid_validity) {
        (Some(server), Some(local)) => server != local,
        _ => false,
    };

    let (missing, missing_uid_range) = match (server_uid_next, local_last_uid) {
        (Some(server_next), Some(local_last))
            if !uid_validity_mismatch && server_next > local_last =>
        {
            let count = i64::from(server_next) - i64::from(local_last) - 1;
            if count > 0 {
                (Some(count), Some((local_last + 1, server_next - 1)))
            } else {
                (Some(0), None)
            }
        }
        _ => (None, None),
    };

    let coverage = status.date_range.as_ref().and_then(|(earliest, _)| {
        let date = if earliest.contains('Z') || earliest.contains('+') {
            chrono::DateTime::parse_from_rfc3339(earliest)
                .ok()
                .map(|d| d.with_timezone(&chrono::Utc))
        } else {
            let normalized = format!("{}Z", earliest.replace(' ', "T"));
            chrono::DateTime::parse_from_rfc3339(&normalized)
                .ok()
                .map(|d| d.with_timezone(&chrono::Utc))
        }?;
        let days_ago = (chrono::Utc::now() - date).num_days().max(0);
        Some(ImapStatusCoverage {
            days_ago,
            years_ago: format!("{:.1}", days_ago as f64 / 365.0),
            earliest_date: earliest[..earliest.len().min(10)].to_string(),
        })
    });

    ImapServerComparison {
        server: ImapStatusSide {
            messages: server_messages.unwrap_or(0) as i64,
            uid_next: server_uid_next,
            uid_validity: server_uid_validity,
        },
        local: ImapStatusSide {
            messages: status.fts_ready,
            uid_next: local_last_uid,
            uid_validity: local_uid_validity,
        },
        missing,
        missing_uid_range,
        uid_validity_mismatch,
        coverage,
    }
}

type SyncSummaryRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    Option<String>,
    i64,
    Option<i64>,
    Option<String>,
);

pub fn get_status(conn: &Connection) -> Result<StatusData, rusqlite::Error> {
    let sync_row: Option<SyncSummaryRow> = conn
        .query_row(
            "SELECT earliest_synced_date, latest_synced_date, target_start_date, sync_start_earliest_date,
                    total_messages, last_sync_at, is_running, owner_pid, sync_lock_started_at
             FROM sync_summary WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .optional()?;

    let messages_count: i64 = conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))?;

    let date_range: Option<(String, String)> =
        conn.query_row("SELECT MIN(date), MAX(date) FROM messages", [], |row| {
            let earliest: Option<String> = row.get(0)?;
            let latest: Option<String> = row.get(1)?;
            Ok(earliest.zip(latest))
        })?;

    let sync = if let Some((
        earliest_synced_date,
        latest_synced_date,
        target_start_date,
        sync_start_earliest_date,
        total_messages,
        last_sync_at,
        is_running,
        _owner_pid,
        _sync_lock_started_at,
    )) = sync_row
    {
        SyncStatus {
            is_running: is_running != 0,
            last_sync_at,
            total_messages,
            earliest_synced_date,
            latest_synced_date,
            target_start_date,
            sync_start_earliest_date,
        }
    } else {
        SyncStatus {
            is_running: false,
            last_sync_at: None,
            total_messages: 0,
            earliest_synced_date: None,
            latest_synced_date: None,
            target_start_date: None,
            sync_start_earliest_date: None,
        }
    };

    Ok(StatusData {
        sync,
        fts_ready: messages_count,
        date_range,
    })
}

pub fn get_imap_server_status(
    conn: &Connection,
    cfg: &Config,
) -> Result<Option<ImapServerComparison>, String> {
    if cfg.imap_user.trim().is_empty() || cfg.imap_password.trim().is_empty() {
        return Ok(None);
    }

    let mut session = connect_imap_session(
        &cfg.imap_host,
        cfg.imap_port,
        &cfg.imap_user,
        &cfg.imap_password,
    )
    .map_err(|e| e.to_string())?;
    let mut transport = RealImapTransport {
        session: &mut session,
    };
    let server_status = transport
        .mailbox_status(&cfg.sync_mailbox)
        .map_err(|e| e.to_string())?;

    let sync_state: Option<(Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT uidvalidity, last_uid FROM sync_state WHERE folder = ?1",
            [&cfg.sync_mailbox],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let status = get_status(conn).map_err(|e| e.to_string())?;
    let local_uid_validity = sync_state.and_then(|(uidvalidity, _)| uidvalidity.map(|v| v as u32));
    let local_last_uid = sync_state.and_then(|(_, last_uid)| last_uid.map(|v| v as u32));
    let _ = session.logout();

    Ok(Some(build_imap_server_comparison(
        &status,
        server_status.messages,
        server_status.uid_next,
        server_status.uid_validity,
        local_last_uid,
        local_uid_validity,
    )))
}

fn progress_suffix(status: &StatusData) -> String {
    let Some(ref target) = status.sync.target_start_date else {
        return String::new();
    };
    let Some(ref start_earliest) = status.sync.sync_start_earliest_date else {
        return String::new();
    };
    let Some(ref current_earliest) = status.sync.earliest_synced_date else {
        return String::new();
    };

    let parse_day = |s: &str| -> Option<chrono::NaiveDate> {
        chrono::NaiveDate::parse_from_str(&s[..s.len().min(10)], "%Y-%m-%d").ok()
    };

    let Some(target_date) = parse_day(target) else {
        return String::new();
    };
    let Some(start_earliest_date) = parse_day(start_earliest) else {
        return String::new();
    };
    let Some(current_earliest_date) = parse_day(current_earliest) else {
        return String::new();
    };

    if current_earliest_date <= target_date {
        return " (100% complete)".into();
    }
    if current_earliest_date >= start_earliest_date {
        return String::new();
    }

    let sync_start_point = start_earliest_date.max(target_date);
    let total_range_days = (sync_start_point - target_date).num_days().max(0);
    let progress_range_days = (sync_start_point - current_earliest_date).num_days().max(0);

    if total_range_days > 0 {
        let progress = ((progress_range_days as f64 / total_range_days as f64) * 100.0)
            .round()
            .clamp(0.0, 100.0) as i64;
        format!(" ({progress}% complete)")
    } else if start_earliest_date <= target_date {
        " (100% complete)".into()
    } else {
        String::new()
    }
}

/// Human-readable status lines (text mode).
pub fn print_status_text(conn: &Connection) -> Result<(), rusqlite::Error> {
    let status = get_status(conn)?;
    let progress_text = progress_suffix(&status);
    let pad = |s: &str| format!("{s:<STATUS_LABEL_WIDTH$}");

    if status.sync.is_running {
        println!("{}running{}", pad("Sync:"), progress_text);
    } else if let Some(ref last) = status.sync.last_sync_at {
        let short = if last.len() >= 10 {
            &last[..10]
        } else {
            last.as_str()
        };
        println!(
            "{}idle (last: {}, {} messages){}",
            pad("Sync:"),
            short,
            status.sync.total_messages,
            progress_text
        );
    } else {
        println!("{}never run", pad("Sync:"));
    }

    println!("{}FTS ready ({})", pad("Search:"), status.fts_ready);

    if let Some((ref earliest, ref latest)) = status.date_range {
        println!(
            "{}{} .. {}",
            pad("Range:"),
            &earliest[..earliest.len().min(10)],
            &latest[..latest.len().min(10)]
        );
        println!("{}{}", pad("Earliest:"), earliest);
        println!("{}{}", pad("Latest:"), latest);
    }

    if let Some(ago) = format_time_ago(status.date_range.as_ref().map(|(_, l)| l.as_str())) {
        println!("{}{} ({})", pad("Newest mail:"), ago.human, ago.duration);
    }

    let last_sync_ago = if status.sync.is_running {
        None
    } else {
        format_time_ago(status.sync.last_sync_at.as_deref())
    };
    if let Some(ago) = last_sync_ago {
        println!("{}{} ({})", pad("Last sync:"), ago.human, ago.duration);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imap_comparison_reports_missing_range() {
        let status = StatusData {
            sync: SyncStatus {
                is_running: false,
                last_sync_at: None,
                total_messages: 0,
                earliest_synced_date: None,
                latest_synced_date: None,
                target_start_date: None,
                sync_start_earliest_date: None,
            },
            fts_ready: 25,
            date_range: Some(("2024-01-01T00:00:00Z".into(), "2024-06-01T00:00:00Z".into())),
        };
        let comparison =
            build_imap_server_comparison(&status, Some(30), Some(15), Some(42), Some(9), Some(42));
        assert_eq!(comparison.missing, Some(5));
        assert_eq!(comparison.missing_uid_range, Some((10, 14)));
        assert!(!comparison.uid_validity_mismatch);
        assert_eq!(comparison.local.messages, 25);
        assert_eq!(comparison.server.messages, 30);
    }

    #[test]
    fn imap_comparison_stops_missing_when_uidvalidity_differs() {
        let status = StatusData {
            sync: SyncStatus {
                is_running: false,
                last_sync_at: None,
                total_messages: 0,
                earliest_synced_date: None,
                latest_synced_date: None,
                target_start_date: None,
                sync_start_earliest_date: None,
            },
            fts_ready: 10,
            date_range: None,
        };
        let comparison =
            build_imap_server_comparison(&status, Some(10), Some(20), Some(2), Some(5), Some(1));
        assert!(comparison.uid_validity_mismatch);
        assert_eq!(comparison.missing, None);
        assert_eq!(comparison.missing_uid_range, None);
    }
}
