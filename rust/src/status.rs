//! Sync / search status from DB — mirrors `src/lib/status.ts`.

use rusqlite::{Connection, OptionalExtension};

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
            format!("{} {} ago", min, if min == 1 { "minute" } else { "minutes" }),
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
            format!("{} {} ago", month, if month == 1 { "month" } else { "months" }),
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

pub fn get_status(conn: &Connection) -> Result<StatusData, rusqlite::Error> {
    let sync_row: Option<(
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
        Option<String>,
        i64,
        Option<i64>,
        Option<String>,
    )> = conn
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
    }

    if let Some(ago) = format_time_ago(status.date_range.as_ref().map(|(_, l)| l.as_str())) {
        println!(
            "{}{} ({})",
            pad("Newest mail:"),
            ago.human,
            ago.duration
        );
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
