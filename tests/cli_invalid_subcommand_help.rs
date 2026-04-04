//! Unrecognized subcommand prints long help for the appropriate parent command.

#[test]
fn unrecognized_top_level_subcommand_prints_root_long_help() {
    let bin = env!("CARGO_BIN_EXE_zmail");
    let out = std::process::Command::new(bin)
        .arg("not-a-real-zmail-cmd")
        .output()
        .expect("spawn zmail");
    assert_eq!(
        out.status.code(),
        Some(2),
        "stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("zmail search"),
        "expected root long help on stdout, got: {stdout:?}"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("unrecognized subcommand"),
        "expected error on stderr, got: {stderr:?}"
    );
}

#[test]
fn unrecognized_nested_subcommand_prints_parent_long_help() {
    let bin = env!("CARGO_BIN_EXE_zmail");
    let out = std::process::Command::new(bin)
        .args(["draft", "not-a-draft-subcmd"])
        .output()
        .expect("spawn zmail");
    assert_eq!(out.status.code(), Some(2));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("Local drafts") && stdout.contains("list"),
        "expected draft long help on stdout, got: {stdout:?}"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("unrecognized subcommand"),
        "stderr={stderr:?}"
    );
}
