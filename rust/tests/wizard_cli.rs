//! `zmail wizard` CLI behavior (non-interactive failure).

use std::process::{Command, Stdio};

use tempfile::tempdir;

#[test]
fn wizard_requires_interactive_terminal() {
    let bin = env!("CARGO_BIN_EXE_zmail");
    let dir = tempdir().unwrap();
    let mut child = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .arg("wizard")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdin.take());
    let out = child.wait_with_output().unwrap();
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("interactive terminal") && stderr.contains("zmail setup"),
        "stderr was: {stderr}"
    );
}
