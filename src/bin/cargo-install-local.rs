//! `cargo install-local` — build release `zmail` and copy to `INSTALL_PREFIX` (default `$HOME/.local/bin`, or `/usr/local/bin` if `HOME` is unset).
//! Invoked as `cargo install-local` via `.cargo/config.toml` alias, or after `cargo install --path .`
//! as the `cargo-install-local` subcommand on `PATH`.
//! On macOS, after copy we run `xattr -cr` and `codesign --force --sign -` on the installed binary
//! so replacing a previously downloaded `zmail` does not leave quarantine metadata that causes SIGKILL at launch.
//!
//! Also installs the publishable **`skills/zmail/`** skill into Claude Code’s user skills dir
//! (**`~/.claude/skills/zmail`** by default, symlink), matching **`npm run install-skill:claude`**.
//! Skip with **`ZMAIL_SKIP_CLAUDE_SKILL=1`**, override destination with **`ZMAIL_CLAUDE_SKILL_DIR`**,
//! use **`ZMAIL_CLAUDE_SKILL_MODE=copy`** instead of symlink.

use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("cargo-install-local: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let root = resolve_workspace()?;
    let cargo = env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let st = Command::new(&cargo)
        .current_dir(&root)
        .args(["build", "--release"])
        .status()
        .map_err(|e| format!("failed to run {cargo}: {e}"))?;
    if !st.success() {
        return Err("cargo build --release failed".into());
    }
    let bin = root.join("target/release/zmail");
    if !bin.is_file() {
        return Err(format!("missing {}", bin.display()));
    }
    let dest_dir = env::var("INSTALL_PREFIX")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_install_prefix());
    let dest = dest_dir.join("zmail");
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    install_file(&bin, &dest)?;
    #[cfg(target_os = "macos")]
    macos_normalize_installed_binary(&dest)?;
    println!("Installed {}", dest.display());
    install_claude_skill(&root)?;
    Ok(())
}

/// User-writable default; falls back to `/usr/local/bin` when `HOME` is missing (e.g. some CI).
fn default_install_prefix() -> PathBuf {
    default_install_prefix_for_home(env::var("HOME").ok().as_deref())
}

fn default_install_prefix_for_home(home: Option<&str>) -> PathBuf {
    if let Some(h) = home.filter(|s| !s.is_empty()) {
        return PathBuf::from(h).join(".local/bin");
    }
    PathBuf::from("/usr/local/bin")
}

fn resolve_workspace() -> Result<PathBuf, String> {
    if let Ok(p) = env::var("ZMAIL_ROOT") {
        let p = PathBuf::from(p);
        if validate_workspace(&p) {
            return Ok(p);
        }
        return Err(format!(
            "ZMAIL_ROOT={} is not a zmail workspace",
            p.display()
        ));
    }
    let start = env::current_dir().map_err(|e| e.to_string())?;
    let mut cur = start.as_path();
    loop {
        let manifest = cur.join("Cargo.toml");
        if manifest.is_file() && is_zmail_manifest(&manifest) {
            return Ok(cur.to_path_buf());
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => {
                return Err(
                    "not inside a zmail repository (no Cargo.toml with name = \"zmail\"); set ZMAIL_ROOT"
                        .into(),
                );
            }
        }
    }
}

fn validate_workspace(root: &Path) -> bool {
    is_zmail_manifest(&root.join("Cargo.toml"))
}

fn is_zmail_manifest(path: &Path) -> bool {
    let Ok(contents) = fs::read_to_string(path) else {
        return false;
    };
    let mut in_package = false;
    for line in contents.lines() {
        let trim = line.trim();
        if trim == "[package]" {
            in_package = true;
            continue;
        }
        if trim.starts_with('[') && trim != "[package]" {
            in_package = false;
        }
        if in_package {
            let trim = trim.split_once('#').map(|x| x.0).unwrap_or(trim).trim();
            if trim.starts_with("name") && trim.contains("\"zmail\"") {
                return true;
            }
        }
    }
    false
}

fn install_file(src: &Path, dest: &Path) -> Result<(), String> {
    fs::copy(src, dest).map_err(|e| format!("copy to {}: {e}", dest.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(dest).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(dest, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn install_claude_skill(workspace_root: &Path) -> Result<(), String> {
    if skip_claude_skill_install() {
        println!("Skipping Claude skill install (ZMAIL_SKIP_CLAUDE_SKILL is set).");
        return Ok(());
    }
    let src = workspace_root.join("skills/zmail");
    if !src.is_dir() {
        return Err(format!(
            "publishable skill missing: {} (expected skills/zmail under repo root)",
            src.display()
        ));
    }
    let dest = claude_skill_dest()?;
    let mode =
        parse_claude_skill_mode_str(&env::var("ZMAIL_CLAUDE_SKILL_MODE").unwrap_or_default())?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    if dest.exists() {
        if dest.is_dir() {
            fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(&dest).map_err(|e| e.to_string())?;
        }
    }
    let src_abs = fs::canonicalize(&src).map_err(|e| format!("{}: {e}", src.display()))?;
    match mode {
        ClaudeSkillMode::Symlink => install_skill_symlink(&src_abs, &dest)?,
        ClaudeSkillMode::Copy => copy_dir_all(&src_abs, &dest).map_err(|e| e.to_string())?,
    }
    println!(
        "Installed zmail skill for Claude Code ({mode}):\n  {}",
        dest.display()
    );
    println!("Start a new Claude Code session or reload skills so /zmail is available.");
    Ok(())
}

fn skip_claude_skill_install() -> bool {
    let Some(v) = env::var("ZMAIL_SKIP_CLAUDE_SKILL").ok() else {
        return false;
    };
    let v = v.trim();
    v == "1" || v.eq_ignore_ascii_case("true")
}

fn claude_skill_dest() -> Result<PathBuf, String> {
    if let Some(p) = env::var("ZMAIL_CLAUDE_SKILL_DIR")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
    {
        return Ok(PathBuf::from(p));
    }
    let home = dirs::home_dir()
        .ok_or_else(|| "cannot resolve home; set ZMAIL_CLAUDE_SKILL_DIR".to_string())?;
    Ok(home.join(".claude/skills/zmail"))
}

#[derive(Clone, Copy)]
enum ClaudeSkillMode {
    Symlink,
    Copy,
}

impl std::fmt::Display for ClaudeSkillMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClaudeSkillMode::Symlink => write!(f, "symlink"),
            ClaudeSkillMode::Copy => write!(f, "copy"),
        }
    }
}

fn parse_claude_skill_mode_str(raw: &str) -> Result<ClaudeSkillMode, String> {
    let raw = raw.trim().to_lowercase();
    if raw.is_empty() || raw == "symlink" {
        return Ok(ClaudeSkillMode::Symlink);
    }
    if raw == "copy" {
        return Ok(ClaudeSkillMode::Copy);
    }
    Err(format!(
        "ZMAIL_CLAUDE_SKILL_MODE must be copy or symlink (got: {raw})"
    ))
}

fn install_skill_symlink(src_abs: &Path, dest: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(src_abs, dest).map_err(|e| {
            format!(
                "symlink {} → {}: {e} (try ZMAIL_CLAUDE_SKILL_MODE=copy)",
                src_abs.display(),
                dest.display()
            )
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::symlink_dir;
        symlink_dir(src_abs, dest).map_err(|e| {
            format!(
                "symlink {} → {}: {e} (try ZMAIL_CLAUDE_SKILL_MODE=copy)",
                src_abs.display(),
                dest.display()
            )
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err("symlink not supported on this platform; use ZMAIL_CLAUDE_SKILL_MODE=copy".into())
    }
}

fn copy_dir_all(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let dst_join = dst.join(&name);
        if path.metadata()?.is_dir() {
            copy_dir_all(&path, &dst_join)?;
        } else {
            fs::copy(&path, &dst_join)?;
        }
    }
    Ok(())
}

/// After install, clear quarantine/provenance-style xattrs and refresh the ad-hoc signature.
/// Without this, a binary previously installed from a download can keep attributes that make
/// AMFI reject the replaced file (SIGKILL before main) on recent macOS.
#[cfg(target_os = "macos")]
fn macos_normalize_installed_binary(path: &Path) -> Result<(), String> {
    let st = Command::new("xattr")
        .args(["-cr", "--"])
        .arg(path)
        .status()
        .map_err(|e| format!("xattr: {e}"))?;
    if !st.success() {
        return Err(format!(
            "xattr -cr {} failed (needed to clear download/quarantine metadata)",
            path.display()
        ));
    }
    let st = Command::new("codesign")
        .args(["--force", "--sign", "-", "--"])
        .arg(path)
        .status()
        .map_err(|e| format!("codesign: {e}"))?;
    if !st.success() {
        return Err(format!(
            "codesign --force --sign - {} failed (re-ad-hoc sign after xattr)",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn manifest_detects_zmail() {
        let dir = tempdir().unwrap();
        let manifest = dir.path().join("Cargo.toml");
        let mut f = fs::File::create(&manifest).unwrap();
        writeln!(f, "[package]").unwrap();
        writeln!(f, "name = \"zmail\"").unwrap();
        writeln!(f, "version = \"0.1.0\"").unwrap();
        assert!(is_zmail_manifest(&manifest));
    }

    #[test]
    fn manifest_rejects_other_name() {
        let dir = tempdir().unwrap();
        let manifest = dir.path().join("Cargo.toml");
        let mut f = fs::File::create(&manifest).unwrap();
        writeln!(f, "[package]").unwrap();
        writeln!(f, "name = \"not-zmail\"").unwrap();
        assert!(!is_zmail_manifest(&manifest));
    }

    #[test]
    fn default_install_prefix_paths() {
        assert_eq!(
            default_install_prefix_for_home(Some("/tmp/u")),
            PathBuf::from("/tmp/u/.local/bin")
        );
        assert_eq!(
            default_install_prefix_for_home(None),
            PathBuf::from("/usr/local/bin")
        );
        assert_eq!(
            default_install_prefix_for_home(Some("")),
            PathBuf::from("/usr/local/bin")
        );
    }

    #[test]
    fn claude_skill_mode_parses() {
        assert!(matches!(
            parse_claude_skill_mode_str("").unwrap(),
            ClaudeSkillMode::Symlink
        ));
        assert!(matches!(
            parse_claude_skill_mode_str("  Symlink ").unwrap(),
            ClaudeSkillMode::Symlink
        ));
        assert!(matches!(
            parse_claude_skill_mode_str("copy").unwrap(),
            ClaudeSkillMode::Copy
        ));
        assert!(parse_claude_skill_mode_str("oops").is_err());
    }

    #[test]
    fn manifest_ignores_dependency_named_zmail() {
        let dir = tempdir().unwrap();
        let manifest = dir.path().join("Cargo.toml");
        let mut f = fs::File::create(&manifest).unwrap();
        writeln!(f, "[package]").unwrap();
        writeln!(f, "name = \"other\"").unwrap();
        writeln!(f, "[dependencies]").unwrap();
        writeln!(f, "zmail = {{ path = \"../zmail\" }}").unwrap();
        assert!(!is_zmail_manifest(&manifest));
    }
}
