//! `cargo install-local` — build release `zmail` and copy to `INSTALL_PREFIX` (default `$HOME/.local/bin`, or `/usr/local/bin` if `HOME` is unset).
//! Invoked as `cargo install-local` via `.cargo/config.toml` alias, or after `cargo install --path .`
//! as the `cargo-install-local` subcommand on `PATH`.

use std::env;
use std::fs;
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
    println!("Installed {}", dest.display());
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
