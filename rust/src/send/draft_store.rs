//! Markdown drafts with YAML frontmatter in `data/drafts/`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DraftMeta {
    pub to: Option<String>,
    pub subject: Option<String>,
    #[serde(default)]
    pub cc: Option<String>,
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
    let yaml = serde_yaml::to_string(meta).unwrap_or_default();
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftListSlim {
    pub id: String,
    pub subject: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftListFull {
    pub id: String,
    pub subject: Option<String>,
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_preview: Option<String>,
}

pub fn list_drafts(dir: &Path, full: bool) -> std::io::Result<Vec<serde_json::Value>> {
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for e in fs::read_dir(dir)? {
        let e = e?;
        let p = e.path();
        if p.extension().is_some_and(|x| x == "md") {
            let d = read_draft(&p)?;
            if full {
                let prev: String = d.body.chars().take(120).collect();
                out.push(serde_json::to_value(DraftListFull {
                    id: d.id.clone(),
                    subject: d.meta.subject.clone(),
                    to: d.meta.to.clone(),
                    body_preview: Some(prev),
                })?);
            } else {
                out.push(serde_json::to_value(DraftListSlim {
                    id: d.id,
                    subject: d.meta.subject,
                })?);
            }
        }
    }
    out.sort_by(|a, b| {
        let sa = a.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let sb = b.get("id").and_then(|x| x.as_str()).unwrap_or("");
        sa.cmp(sb)
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn write_read_roundtrip() {
        let dir = tempdir().unwrap();
        let meta = DraftMeta {
            to: Some("bob@x.com".into()),
            subject: Some("Hi".into()),
            cc: None,
        };
        let path = write_draft(dir.path(), "abc", &meta, "Body\n").unwrap();
        let d = read_draft(&path).unwrap();
        assert_eq!(d.id, "abc");
        assert_eq!(d.meta.to.as_deref(), Some("bob@x.com"));
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
}
