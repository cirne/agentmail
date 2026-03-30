//! Markdown drafts with YAML frontmatter in `data/drafts/`.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

/// Max length of the subject-derived slug before `_` and the 8-char unique suffix.
pub const DRAFT_SUBJECT_SLUG_MAX: usize = 40;

/// Match search `bodyPreview` length for draft list JSON.
pub const DRAFT_LIST_BODY_PREVIEW_LEN: usize = 300;

const SUFFIX_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DraftMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_addr_list",
        skip_serializing_if = "Option::is_none"
    )]
    pub to: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_addr_list",
        skip_serializing_if = "Option::is_none"
    )]
    pub cc: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_addr_list",
        skip_serializing_if = "Option::is_none"
    )]
    pub bcc: Option<Vec<String>>,
    pub subject: Option<String>,
    #[serde(default, rename = "inReplyTo")]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Option<String>,
    #[serde(default, rename = "sourceMessageId")]
    pub source_message_id: Option<String>,
    #[serde(default, rename = "threadId")]
    pub thread_id: Option<String>,
    #[serde(default, rename = "forwardOf")]
    pub forward_of: Option<String>,
}

fn deserialize_optional_addr_list<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StrOrVec {
        String(String),
        Vec(Vec<String>),
    }
    match Option::<StrOrVec>::deserialize(deserializer)? {
        None => Ok(None),
        Some(StrOrVec::String(s)) => {
            let addrs = super::split_address_list(&s);
            if addrs.is_empty() {
                Ok(None)
            } else {
                Ok(Some(addrs))
            }
        }
        Some(StrOrVec::Vec(v)) => {
            if v.is_empty() {
                Ok(None)
            } else {
                Ok(Some(v))
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct DraftFile {
    pub id: String,
    pub path: PathBuf,
    pub meta: DraftMeta,
    pub body: String,
}

fn split_frontmatter(raw: &str) -> Option<(DraftMeta, String)> {
    let raw = raw.trim_start_matches('\u{feff}');
    let rest = raw.strip_prefix("---")?;
    let rest = rest
        .strip_prefix('\n')
        .or_else(|| rest.strip_prefix("\r\n"))?;
    let end = rest.find("\n---\n").or_else(|| rest.find("\n---\r\n"))?;
    let yaml_part = rest[..end].trim();
    let body = rest[end + 5..]
        .trim_start_matches('\r')
        .trim_start_matches('\n')
        .to_string();
    let meta: DraftMeta = serde_yaml::from_str(yaml_part).ok()?;
    Some((meta, body))
}

pub fn write_draft(dir: &Path, id: &str, meta: &DraftMeta, body: &str) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let path = dir.join(format!("{id}.md"));
    let mut meta = meta.clone();
    meta.id = Some(id.to_string());
    let yaml = serde_yaml::to_string(&meta).unwrap_or_default();
    let content = format!("---\n{yaml}\n---\n{body}");
    fs::write(&path, content)?;
    Ok(path)
}

pub fn read_draft(path: &Path) -> std::io::Result<DraftFile> {
    let raw = fs::read_to_string(path)?;
    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("draft")
        .to_string();
    let (meta, body) = split_frontmatter(&raw).unwrap_or((DraftMeta::default(), raw));
    Ok(DraftFile {
        id,
        path: path.to_path_buf(),
        meta,
        body,
    })
}

/// User-facing message when `data/drafts/{id}.md` is missing (parity with Node `formatSendDraftNotFoundMessage`).
pub fn format_draft_not_found_message(id: &str, expected_path: &Path) -> String {
    format!(
        "Draft not found: {id}. Expected file:\n  {}\nRun `zmail draft list` to see saved draft ids.",
        expected_path.display()
    )
}

/// Read a draft by id under `data_dir/drafts/`.
pub fn read_draft_in_data_dir(data_dir: &Path, id: &str) -> std::io::Result<DraftFile> {
    let base = normalize_draft_filename(id);
    let path = data_dir.join("drafts").join(format!("{base}.md"));
    match read_draft(&path) {
        Ok(d) => Ok(d),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format_draft_not_found_message(&base, &path),
        )),
        Err(e) => Err(e),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftListSlim {
    pub id: String,
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftListFull {
    pub id: String,
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub body_preview: String,
}

#[derive(Debug, Clone)]
pub struct DraftListRow {
    pub id: String,
    pub path: PathBuf,
    pub kind: String,
    pub subject: Option<String>,
    pub body_preview: String,
}

pub fn draft_body_preview(body: &str, max_len: usize) -> String {
    let t = body.trim();
    if t.is_empty() {
        return String::new();
    }
    if t.len() <= max_len {
        return t.to_string();
    }
    format!("{}…", &t[..max_len])
}

pub fn draft_list_slim_hint() -> &'static str {
    "Large draft list — slim rows (id, path, kind, subject). Use zmail draft view <id>, read_file on path, or list with --result-format full for bodyPreview."
}

/// Strip optional `.md` suffix for paths and CLI ids (mirrors TS `normalizeDraftFilename`).
pub fn normalize_draft_filename(id: &str) -> String {
    id.trim().trim_end_matches(".md").to_string()
}

/// Turn a subject line into a filesystem-safe slug: lowercase [a-z0-9-] only.
pub fn subject_to_slug(subject: &str, max_len: usize) -> String {
    let trimmed = subject.trim();
    let ascii: String = trimmed
        .chars()
        .map(|ch| {
            let lower = ch.to_lowercase().next().unwrap_or(ch);
            if lower.is_ascii_alphanumeric() {
                lower.to_string()
            } else if ch.is_whitespace() || "/._".contains(ch) {
                "-".to_string()
            } else {
                String::new()
            }
        })
        .collect();
    let mut slug = ascii
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.len() > max_len {
        slug = slug.chars().take(max_len).collect();
        slug = slug.trim_end_matches('-').to_string();
    }
    if slug.is_empty() {
        "draft".into()
    } else {
        slug
    }
}

fn random_suffix_8() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15);
    let mut s = String::with_capacity(8);
    for _ in 0..8 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let idx = (seed % SUFFIX_ALPHABET.len() as u64) as usize;
        s.push(SUFFIX_ALPHABET[idx] as char);
    }
    s
}

/// Allocate a unique draft id: `{slug}_{8 alphanumeric chars}`.
pub fn create_draft_id(drafts_dir: &Path, subject: &str) -> std::io::Result<String> {
    fs::create_dir_all(drafts_dir)?;
    let slug = subject_to_slug(subject, DRAFT_SUBJECT_SLUG_MAX);
    for _ in 0..128 {
        let id = format!("{}_{}", slug, random_suffix_8());
        let p = drafts_dir.join(format!("{id}.md"));
        if !p.exists() {
            return Ok(id);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "Could not allocate a unique draft id",
    ))
}

/// List `.md` drafts with metadata for CLI / JSON.
pub fn list_draft_rows(drafts_dir: &Path) -> std::io::Result<Vec<DraftListRow>> {
    let mut out = Vec::new();
    if !drafts_dir.is_dir() {
        return Ok(out);
    }
    for e in fs::read_dir(drafts_dir)? {
        let e = e?;
        let p = e.path();
        if p.extension().is_some_and(|x| x == "md") {
            if let Ok(d) = read_draft(&p) {
                let kind = d.meta.kind.clone().unwrap_or_else(|| "new".into());
                out.push(DraftListRow {
                    id: d.id.clone(),
                    path: d.path.clone(),
                    kind,
                    subject: d.meta.subject.clone(),
                    body_preview: draft_body_preview(&d.body, DRAFT_LIST_BODY_PREVIEW_LEN),
                });
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

pub fn list_drafts(dir: &Path, full: bool) -> std::io::Result<Vec<serde_json::Value>> {
    let rows = list_draft_rows(dir)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let abs = r.path.canonicalize().unwrap_or(r.path.clone());
        let path_str = abs.to_string_lossy().into_owned();
        if full {
            out.push(serde_json::to_value(DraftListFull {
                id: r.id,
                path: path_str,
                kind: r.kind,
                subject: r.subject,
                body_preview: r.body_preview,
            })?);
        } else {
            out.push(serde_json::to_value(DraftListSlim {
                id: r.id,
                path: path_str,
                kind: r.kind,
                subject: r.subject,
            })?);
        }
    }
    Ok(out)
}

/// JSON view of a draft (agent-first: absolute path; body optional).
pub fn draft_file_to_json(d: &DraftFile, with_body: bool) -> serde_json::Value {
    let abs = d.path.canonicalize().unwrap_or_else(|_| d.path.clone());
    let mut m = serde_json::Map::new();
    m.insert("path".into(), json!(abs.to_string_lossy()));
    m.insert("id".into(), json!(d.id));
    if let Some(ref k) = d.meta.kind {
        m.insert("kind".into(), json!(k));
    }
    if let Some(ref t) = d.meta.to {
        m.insert("to".into(), json!(t));
    }
    if let Some(ref c) = d.meta.cc {
        m.insert("cc".into(), json!(c));
    }
    if let Some(ref b) = d.meta.bcc {
        m.insert("bcc".into(), json!(b));
    }
    if let Some(ref s) = d.meta.subject {
        m.insert("subject".into(), json!(s));
    }
    if let Some(ref x) = d.meta.in_reply_to {
        m.insert("inReplyTo".into(), json!(x));
    }
    if let Some(ref x) = d.meta.references {
        m.insert("references".into(), json!(x));
    }
    if let Some(ref x) = d.meta.source_message_id {
        m.insert("sourceMessageId".into(), json!(x));
    }
    if let Some(ref x) = d.meta.thread_id {
        m.insert("threadId".into(), json!(x));
    }
    if let Some(ref x) = d.meta.forward_of {
        m.insert("forwardOf".into(), json!(x));
    }
    if with_body {
        m.insert("body".into(), json!(d.body));
    }
    serde_json::Value::Object(m)
}

pub fn format_draft_view_text(d: &DraftFile) -> String {
    let fm = &d.meta;
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("Path: {}", d.path.display()));
    lines.push(format!("Kind: {}", fm.kind.as_deref().unwrap_or("")));
    if let Some(ref t) = fm.to {
        if !t.is_empty() {
            lines.push(format!("To: {}", t.join(", ")));
        }
    }
    if let Some(ref c) = fm.cc {
        if !c.is_empty() {
            lines.push(format!("Cc: {}", c.join(", ")));
        }
    }
    if let Some(ref b) = fm.bcc {
        if !b.is_empty() {
            lines.push(format!("Bcc: {}", b.join(", ")));
        }
    }
    if fm.subject.as_ref().is_some_and(|s| !s.is_empty()) {
        lines.push(format!("Subject: {}", fm.subject.as_deref().unwrap_or("")));
    }
    if let Some(ref x) = fm.thread_id {
        lines.push(format!("Thread-ID: {x}"));
    }
    if let Some(ref x) = fm.source_message_id {
        lines.push(format!("Source-Message-ID: {x}"));
    }
    if let Some(ref x) = fm.forward_of {
        lines.push(format!("Forward-Of: {x}"));
    }
    if let Some(ref x) = fm.in_reply_to {
        lines.push(format!("In-Reply-To: {x}"));
    }
    if let Some(ref x) = fm.references {
        lines.push(format!("References: {x}"));
    }
    lines.push(String::new());
    lines.push("---".into());
    lines.push(String::new());
    lines.push(d.body.clone());
    lines.join("\n")
}

/// After a successful SMTP send, move `drafts/{stem}.md` → `sent/{stem}.md` under `data_dir`.
pub fn archive_draft_to_sent(data_dir: &Path, draft_id: &str) -> std::io::Result<PathBuf> {
    let base = normalize_draft_filename(draft_id);
    let src = data_dir.join("drafts").join(format!("{base}.md"));
    let sent = data_dir.join("sent");
    fs::create_dir_all(&sent)?;
    let dest = sent.join(format!("{base}.md"));
    fs::rename(&src, &dest)?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn write_read_roundtrip() {
        let dir = tempdir().unwrap();
        let meta = DraftMeta {
            to: Some(vec!["bob@x.com".into()]),
            subject: Some("Hi".into()),
            ..Default::default()
        };
        let path = write_draft(dir.path(), "abc", &meta, "Body\n").unwrap();
        let d = read_draft(&path).unwrap();
        assert_eq!(d.id, "abc");
        assert_eq!(
            d.meta.to.as_ref().map(|v| v.join(",")),
            Some("bob@x.com".into())
        );
        assert_eq!(d.body, "Body\n");
    }

    #[test]
    fn read_without_frontmatter_uses_raw_body() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("plain.md");
        std::fs::write(&path, "Just text\nno yaml").unwrap();
        let d = read_draft(&path).unwrap();
        assert!(d.meta.to.is_none());
        assert_eq!(d.body, "Just text\nno yaml");
    }

    #[test]
    fn list_drafts_sorts_by_id() {
        let dir = tempdir().unwrap();
        write_draft(dir.path(), "b", &DraftMeta::default(), "x").unwrap();
        write_draft(dir.path(), "a", &DraftMeta::default(), "y").unwrap();
        let list = list_drafts(dir.path(), false).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].get("id").and_then(|v| v.as_str()), Some("a"));
    }

    #[test]
    fn subject_to_slug_basic() {
        assert_eq!(subject_to_slug("Hello World!", 40), "hello-world");
    }

    #[test]
    fn read_draft_in_data_dir_missing_maps_not_found_message() {
        let dir = tempdir().unwrap();
        let data = dir.path();
        let err = read_draft_in_data_dir(data, "does-not-exist-12345").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
        let msg = err.to_string();
        assert!(
            msg.contains("does-not-exist-12345"),
            "expected id in message: {msg:?}"
        );
        assert!(msg.contains("draft list"), "expected hint: {msg:?}");
        let expected = data.join("drafts").join("does-not-exist-12345.md");
        assert!(msg.contains(&*expected.to_string_lossy()), "{msg:?}");
    }
}
