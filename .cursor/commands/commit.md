# Commit

Run the full pre-commit workflow: read and follow **`.cursor/skills/commit/SKILL.md`** end-to end (mandatory documentation review first, then Rust `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` from the repository root). If everything passes, stage, commit with a clear message, and push—unless the user asked otherwise or there are blockers you cannot fix.
