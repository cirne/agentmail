//! Detached `zmail sync` child process (same behavior as CLI background sync).

use std::path::Path;
use std::process::Stdio;

use crate::config::Config;
use crate::db;
use crate::status::print_status_text;
use crate::sync::{connect_imap_session, is_sync_lock_held, sync_log_path, SyncLockRow};

/// Spawn the current binary with `sync --foreground [--since …]` in the background (Node `detached: true`).
pub fn spawn_sync_background_detached(
    home: &Path,
    cfg: &Config,
    since_override: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    if cfg.imap_user.trim().is_empty() || cfg.imap_password.trim().is_empty() {
        return Err("IMAP user/password required. Run `zmail setup`.".into());
    }
    let conn = db::open_file(cfg.db_path())?;
    let lock_row: Option<SyncLockRow> = conn
        .query_row(
            "SELECT is_running, owner_pid, sync_lock_started_at FROM sync_summary WHERE id = 1",
            [],
            |row| {
                Ok(SyncLockRow {
                    is_running: row.get(0)?,
                    owner_pid: row.get(1)?,
                    sync_lock_started_at: row.get(2)?,
                })
            },
        )
        .ok();
    if is_sync_lock_held(lock_row.as_ref()) {
        println!(
            "Sync already running (PID: {:?})\n",
            lock_row.and_then(|r| r.owner_pid)
        );
        print_status_text(&conn)?;
        return Ok(());
    }
    drop(conn);

    let mut auth = connect_imap_session(
        &cfg.imap_host,
        cfg.imap_port,
        &cfg.imap_user,
        &cfg.imap_password,
    )?;
    let _ = auth.logout();

    let exe = std::env::current_exe()?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("sync").arg("--foreground");
    if let Some(s) = since_override {
        if !s.is_empty() {
            cmd.arg("--since").arg(s);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    let pid = {
        let child = cmd.spawn()?;
        child.id()
    };

    let log = sync_log_path(home);
    let empty_index: i64 = {
        let c = db::open_file(cfg.db_path())?;
        c.query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))?
    };

    println!();
    println!("Sync running in background.");
    println!("  PID:    {pid}");
    println!("  Log:    {}", log.display());
    println!("  Status: zmail status");
    if empty_index == 0 {
        println!();
        println!("Initial sync can take a while — tail the log or run `zmail status`.");
        println!("When messages appear, try: zmail search \"invoice\"  |  zmail who \"name\"");
    }
    Ok(())
}
