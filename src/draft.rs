//! `zmail draft` subcommands (ported from `node/src/cli/send-draft.ts`).

/// Default subject when `draft new` is run without `--subject` (fill in later with `draft rewrite` / `draft edit`).
pub const DRAFT_NEW_PLACEHOLDER_SUBJECT: &str = "(no subject yet)";

/// Default body when `draft new` is run with only `--to` or without body content.
pub const DRAFT_NEW_PLACEHOLDER_BODY: &str = "(No body yet — use `zmail draft rewrite <id> …` to set the body, or `zmail draft edit <id> <instruction>` with an OpenAI key.)";

use clap::Subcommand;
use rusqlite::Connection;
use std::path::PathBuf;

use crate::config::{resolve_openai_api_key, Config, LoadConfigOptions};
use crate::ids::resolve_message_id;
use crate::search::SearchResultFormatPreference;
use crate::send::split_address_list;
use crate::send::{
    build_draft_list_json_payload, compose_forward_draft_body, compose_new_draft_from_instruction,
    create_draft_id, draft_file_to_json, format_draft_view_text, list_draft_rows,
    load_forward_source_excerpt, read_draft_in_data_dir, rewrite_draft_with_instruction,
    write_draft, DraftMeta,
};

#[derive(Subcommand)]
pub enum DraftCmd {
    /// List drafts (JSON by default)
    List {
        #[arg(long, conflicts_with = "json")]
        text: bool,
        #[arg(long, conflicts_with = "text")]
        json: bool,
        #[arg(long, value_parser = ["auto", "full", "slim"])]
        result_format: Option<String>,
    },
    /// Show one draft
    View {
        id: String,
        #[arg(long, conflicts_with = "json")]
        text: bool,
        #[arg(long, conflicts_with = "text")]
        json: bool,
        #[arg(long)]
        with_body: bool,
    },
    /// Create a new draft (`--subject` and optional body, `--instruction` for LLM, or placeholders if only `--to`)
    New {
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        subject: Option<String>,
        #[arg(long)]
        body: Option<String>,
        #[arg(long)]
        body_file: Option<PathBuf>,
        #[arg(long)]
        instruction: Option<String>,
        #[arg(long)]
        with_body: bool,
        #[arg(long, conflicts_with = "json")]
        text: bool,
        #[arg(long, conflicts_with = "text")]
        json: bool,
    },
    /// Reply draft from indexed message
    Reply {
        #[arg(long)]
        message_id: String,
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        subject: Option<String>,
        #[arg(long)]
        body: Option<String>,
        #[arg(long)]
        body_file: Option<PathBuf>,
        #[arg(long)]
        with_body: bool,
        #[arg(long, conflicts_with = "json")]
        text: bool,
        #[arg(long, conflicts_with = "text")]
        json: bool,
    },
    /// Forward draft from indexed message
    Forward {
        #[arg(long)]
        message_id: String,
        #[arg(long)]
        to: String,
        #[arg(long)]
        subject: Option<String>,
        #[arg(long)]
        body: Option<String>,
        #[arg(long)]
        body_file: Option<PathBuf>,
        #[arg(long)]
        with_body: bool,
        #[arg(long, conflicts_with = "json")]
        text: bool,
        #[arg(long, conflicts_with = "text")]
        json: bool,
    },
    /// LLM edit of an existing draft
    Edit {
        id: String,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        instruction: Vec<String>,
        #[arg(long)]
        with_body: bool,
        #[arg(long, conflicts_with = "json")]
        text: bool,
        #[arg(long, conflicts_with = "text")]
        json: bool,
    },
    /// Replace draft body (and optional headers) without LLM
    Rewrite {
        id: String,
        #[arg(long)]
        subject: Option<String>,
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        body_file: Option<PathBuf>,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        body_words: Vec<String>,
        #[arg(long)]
        with_body: bool,
        #[arg(long, conflicts_with = "json")]
        text: bool,
        #[arg(long, conflicts_with = "text")]
        json: bool,
    },
}

fn parse_result_format(s: Option<&str>) -> SearchResultFormatPreference {
    match s {
        Some("full") => SearchResultFormatPreference::Full,
        Some("slim") => SearchResultFormatPreference::Slim,
        _ => SearchResultFormatPreference::Auto,
    }
}

pub fn run_draft(
    cmd: DraftCmd,
    cfg: &Config,
    conn: Option<&Connection>,
) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = &cfg.data_dir;
    let drafts_dir = data_dir.join("drafts");

    match cmd {
        DraftCmd::List {
            text,
            json: _,
            result_format,
        } => {
            let pref = parse_result_format(result_format.as_deref());
            let rows = list_draft_rows(&drafts_dir)?;
            if text {
                use crate::search::{resolve_search_json_format, SearchJsonFormat};
                let fmt = resolve_search_json_format(rows.len(), pref, true);
                for r in &rows {
                    println!(
                        "{}\t{}\t{}\t{}",
                        r.id,
                        r.kind,
                        r.subject.as_deref().unwrap_or(""),
                        r.path.display()
                    );
                    if matches!(fmt, SearchJsonFormat::Full) && !r.body_preview.trim().is_empty() {
                        let preview: String = r.body_preview.chars().take(120).collect();
                        let ellip = if r.body_preview.chars().count() > 120 {
                            "…"
                        } else {
                            ""
                        };
                        println!("    {preview}{ellip}");
                    }
                }
                if matches!(fmt, SearchJsonFormat::Slim) && !rows.is_empty() {
                    println!();
                    println!("{}", crate::send::draft_list_slim_hint());
                }
            } else {
                let v = build_draft_list_json_payload(&rows, pref);
                println!("{}", serde_json::to_string_pretty(&v)?);
            }
        }
        DraftCmd::View {
            id,
            text,
            json: _,
            with_body,
        } => {
            let d = read_draft_in_data_dir(data_dir, &id).map_err(|e| e.to_string())?;
            if text {
                println!("{}", format_draft_view_text(&d));
            } else {
                let v = draft_file_to_json(&d, with_body);
                println!("{}", serde_json::to_string_pretty(&v)?);
            }
        }
        DraftCmd::New {
            to,
            subject,
            body,
            body_file,
            instruction,
            with_body,
            text,
            json: _,
        } => {
            let Some(to_s) = to.filter(|s| !s.trim().is_empty()) else {
                return Err("zmail draft new requires --to".into());
            };
            let to_list = split_address_list(&to_s);
            let subj_opt = subject
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let instr_opt = instruction
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());

            // LLM compose: --instruction (no --subject). No stdin for instruction (avoids hangs in non-TTY).
            let use_llm = subj_opt.is_none() && instr_opt.is_some();
            let has_explicit_body = body.is_some() || body_file.is_some();

            let (subj, body_s) = if use_llm {
                let instr = instr_opt.unwrap();
                let api_key = resolve_openai_api_key(&LoadConfigOptions {
                    home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                    env: None,
                })
                .ok_or("zmail draft new requires ZMAIL_OPENAI_API_KEY for LLM compose.")?;
                let rt = tokio::runtime::Runtime::new()?;
                rt.block_on(compose_new_draft_from_instruction(
                    to_list.clone(),
                    &instr,
                    &api_key,
                ))?
            } else if let Some(subj) = subj_opt {
                let mut b = body;
                if let Some(ref p) = body_file {
                    b = Some(std::fs::read_to_string(p)?);
                }
                (subj, b.unwrap_or_default())
            } else if has_explicit_body {
                // No subject but --body and/or --body_file: placeholder subject + that content (no stdin).
                let mut b = body;
                if let Some(ref p) = body_file {
                    b = Some(std::fs::read_to_string(p)?);
                }
                (
                    DRAFT_NEW_PLACEHOLDER_SUBJECT.to_string(),
                    b.unwrap_or_default(),
                )
            } else {
                // Only --to (or nothing else): placeholder subject + body; edit/rewrite later.
                (
                    DRAFT_NEW_PLACEHOLDER_SUBJECT.to_string(),
                    DRAFT_NEW_PLACEHOLDER_BODY.to_string(),
                )
            };
            let id = create_draft_id(&drafts_dir, &subj)?;
            let meta = DraftMeta {
                kind: Some("new".into()),
                to: Some(to_list),
                subject: Some(subj),
                ..Default::default()
            };
            write_draft(&drafts_dir, &id, &meta, &body_s)?;
            let d = read_draft_in_data_dir(data_dir, &id).map_err(|e| e.to_string())?;
            if text {
                println!("{}", format_draft_view_text(&d));
            } else {
                let v = draft_file_to_json(&d, with_body);
                println!("{}", serde_json::to_string_pretty(&v)?);
            }
        }
        DraftCmd::Reply {
            message_id,
            to,
            subject,
            body,
            body_file,
            with_body,
            text,
            json: _,
        } => {
            let Some(conn) = conn else {
                return Err(
                    "internal error: draft reply requires the local database connection".into(),
                );
            };
            let Some(mid) = resolve_message_id(conn, &message_id)? else {
                return Err(format!("Message not found: {message_id}").into());
            };
            let row: Option<(String, String, String, String)> = conn
                .query_row(
                    "SELECT message_id, from_address, subject, thread_id FROM messages WHERE message_id = ?1",
                    [&mid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .ok();
            let Some((msg_id, from_addr, subj_row, thread_id)) = row else {
                return Err(format!("Message not found: {message_id}").into());
            };
            let to_list = if let Some(t) = to.filter(|s| !s.trim().is_empty()) {
                split_address_list(&t)
            } else {
                vec![from_addr]
            };
            let subj = subject.unwrap_or_else(|| {
                if subj_row.starts_with("Re:") {
                    subj_row.clone()
                } else {
                    format!("Re: {subj_row}")
                }
            });
            let mut b = body;
            if let Some(ref p) = body_file {
                b = Some(std::fs::read_to_string(p)?);
            }
            let body_s = b.unwrap_or_default();
            let id = create_draft_id(&drafts_dir, &subj)?;
            let meta = DraftMeta {
                kind: Some("reply".into()),
                to: Some(to_list),
                subject: Some(subj),
                source_message_id: Some(msg_id),
                thread_id: Some(thread_id),
                ..Default::default()
            };
            write_draft(&drafts_dir, &id, &meta, &body_s)?;
            let d = read_draft_in_data_dir(data_dir, &id).map_err(|e| e.to_string())?;
            if text {
                println!("{}", format_draft_view_text(&d));
            } else {
                let v = draft_file_to_json(&d, with_body);
                println!("{}", serde_json::to_string_pretty(&v)?);
            }
        }
        DraftCmd::Forward {
            message_id,
            to,
            subject,
            body,
            body_file,
            with_body,
            text,
            json: _,
        } => {
            let Some(conn) = conn else {
                return Err(
                    "internal error: draft forward requires the local database connection".into(),
                );
            };
            let Some(mid) = resolve_message_id(conn, &message_id)? else {
                return Err(format!("Message not found: {message_id}").into());
            };
            let row: Option<(String, String, String)> = conn
                .query_row(
                    "SELECT message_id, subject, thread_id FROM messages WHERE message_id = ?1",
                    [&mid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .ok();
            let Some((msg_id, subj_row, thread_id)) = row else {
                return Err(format!("Message not found: {message_id}").into());
            };
            let to_list = split_address_list(&to);
            let subj = subject.unwrap_or_else(|| format!("Fwd: {subj_row}"));
            let mut preamble = body;
            if let Some(ref p) = body_file {
                preamble = Some(std::fs::read_to_string(p)?);
            }
            let pre = preamble.unwrap_or_default();
            let excerpt = load_forward_source_excerpt(conn, data_dir, &msg_id)?;
            let body_s = compose_forward_draft_body(&pre, &excerpt);
            let id = create_draft_id(&drafts_dir, &subj)?;
            let meta = DraftMeta {
                kind: Some("forward".into()),
                to: Some(to_list),
                subject: Some(subj),
                forward_of: Some(msg_id),
                thread_id: Some(thread_id),
                ..Default::default()
            };
            write_draft(&drafts_dir, &id, &meta, &body_s)?;
            let d = read_draft_in_data_dir(data_dir, &id).map_err(|e| e.to_string())?;
            if text {
                println!("{}", format_draft_view_text(&d));
            } else {
                let v = draft_file_to_json(&d, with_body);
                println!("{}", serde_json::to_string_pretty(&v)?);
            }
        }
        DraftCmd::Edit {
            id,
            instruction,
            with_body,
            text,
            json: _,
        } => {
            let instr = instruction
                .into_iter()
                .filter(|a| a != "--text" && a != "--with-body" && a != "--json")
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
                .to_string();
            if instr.is_empty() {
                return Err(
                    "zmail draft edit: instruction required (words after the draft id).".into(),
                );
            }
            let api_key = resolve_openai_api_key(&LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
                env: None,
            })
            .ok_or("zmail draft edit requires ZMAIL_OPENAI_API_KEY.")?;
            let d = read_draft_in_data_dir(data_dir, &id).map_err(|e| e.to_string())?;
            let rt = tokio::runtime::Runtime::new()?;
            let revised = rt.block_on(rewrite_draft_with_instruction(&d, &instr, &api_key))?;
            let mut meta = d.meta.clone();
            if let Some(s) = revised.subject {
                meta.subject = Some(s);
            }
            write_draft(&drafts_dir, &d.id, &meta, &revised.body)?;
            let d2 = read_draft_in_data_dir(data_dir, &id).map_err(|e| e.to_string())?;
            if text {
                println!("{}", format_draft_view_text(&d2));
            } else {
                let v = draft_file_to_json(&d2, with_body);
                println!("{}", serde_json::to_string_pretty(&v)?);
            }
        }
        DraftCmd::Rewrite {
            id,
            subject,
            to,
            body_file,
            body_words,
            with_body,
            text,
            json: _,
        } => {
            let d = read_draft_in_data_dir(data_dir, &id).map_err(|e| e.to_string())?;
            let body = if let Some(ref p) = body_file {
                std::fs::read_to_string(p)?
            } else if !body_words.is_empty() {
                body_words.join(" ")
            } else {
                return Err(
                    "zmail draft rewrite: body required (words after id, or --body-file <path>)."
                        .into(),
                );
            };
            let mut meta = d.meta.clone();
            if let Some(s) = subject {
                meta.subject = Some(s);
            }
            if let Some(t) = to {
                meta.to = Some(split_address_list(&t));
            }
            write_draft(&drafts_dir, &d.id, &meta, body.trim_end())?;
            let d2 = read_draft_in_data_dir(data_dir, &id).map_err(|e| e.to_string())?;
            if text {
                println!("{}", format_draft_view_text(&d2));
            } else {
                let v = draft_file_to_json(&d2, with_body);
                println!("{}", serde_json::to_string_pretty(&v)?);
            }
        }
    }

    Ok(())
}
