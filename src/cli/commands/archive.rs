use crate::cli::util::load_cfg;
use crate::cli::CliResult;
use zmail::{archive_messages_locally, db, provider_archive_message};

pub(crate) fn run_archive(
    message_ids: Vec<String>,
    undo: bool,
    text: bool,
    _json: bool,
) -> CliResult {
    let cfg = load_cfg();
    let conn = db::open_file(cfg.db_path())?;
    let archived = !undo;
    let mut results = Vec::new();
    for mid in &message_ids {
        let local_ok = archive_messages_locally(&conn, std::slice::from_ref(mid), archived)?;
        let provider = provider_archive_message(&cfg, &conn, mid, undo);
        results.push(serde_json::json!({
            "messageId": mid,
            "local": { "ok": local_ok > 0, "isArchived": archived },
            "providerMutation": provider,
        }));
    }
    if text {
        for r in &results {
            println!(
                "{} local={} providerAttempted={}",
                r["messageId"].as_str().unwrap_or(""),
                r["local"]["ok"].as_bool().unwrap_or(false),
                r["providerMutation"]["attempted"]
                    .as_bool()
                    .unwrap_or(false),
            );
        }
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({ "results": results }))?
        );
    }
    Ok(())
}
