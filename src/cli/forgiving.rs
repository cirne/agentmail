//! Retry CLI parsing after stripping unrecognized flags (agent-friendly).

use std::ffi::OsString;

use clap::error::{ContextKind, ContextValue, ErrorKind};
use clap::Parser;

use super::args::Cli;

const MAX_UNKNOWN_FLAG_STRIPS: usize = 64;

fn invalid_arg_token(err: &clap::Error) -> Option<String> {
    match err.get(ContextKind::InvalidArg)? {
        ContextValue::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// Remove one argv token matching clap's unknown-flag token (long, `--k=v`, exact short, or short cluster).
fn strip_matching_arg(args: &mut Vec<OsString>, invalid: &str) -> bool {
    if invalid.is_empty() {
        return false;
    }

    if let Some(i) = args.iter().position(|a| a.to_string_lossy() == invalid) {
        args.remove(i);
        return true;
    }

    if invalid.starts_with("--") && !invalid.contains('=') {
        let prefix = format!("{invalid}=");
        if let Some(i) = args
            .iter()
            .position(|a| a.to_string_lossy().starts_with(&prefix))
        {
            args.remove(i);
            return true;
        }
    }

    if let Some(bad) = invalid
        .strip_prefix('-')
        .filter(|s| s.len() == 1)
        .and_then(|s| s.chars().next())
        .filter(|_| !invalid.starts_with("--"))
    {
        for i in 1..args.len() {
            let t = args[i].to_string_lossy();
            if t == invalid {
                args.remove(i);
                return true;
            }
            if t.starts_with("--") || !t.starts_with('-') || t.len() <= 1 {
                continue;
            }
            let rest: Vec<char> = t.chars().skip(1).collect();
            if let Some(pos) = rest.iter().position(|&c| c == bad) {
                let mut new_rest = rest;
                new_rest.remove(pos);
                if new_rest.is_empty() {
                    args.remove(i);
                } else {
                    args[i] = OsString::from(format!("-{}", new_rest.iter().collect::<String>()));
                }
                return true;
            }
        }
    }

    false
}

pub(crate) fn parse_cli_forgiving(
    mut args: Vec<OsString>,
) -> Result<(Cli, Vec<String>), (Vec<String>, clap::Error)> {
    let mut notes: Vec<String> = Vec::new();

    for _ in 0..MAX_UNKNOWN_FLAG_STRIPS {
        match Cli::try_parse_from(&args) {
            Ok(cli) => return Ok((cli, notes)),
            Err(e) => {
                if e.kind() == ErrorKind::UnknownArgument {
                    if let Some(token) = invalid_arg_token(&e) {
                        if strip_matching_arg(&mut args, &token) {
                            notes.push(format!("unrecognized flag {token}; ignoring"));
                            continue;
                        }
                    }
                }
                return Err((notes, e));
            }
        }
    }

    Err((
        notes,
        clap::Error::raw(ErrorKind::UnknownArgument, "too many unrecognized flags"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::args::Commands;
    use zmail::draft::DraftCmd;

    #[test]
    fn forgiving_strips_and_parses_draft_list() {
        let args = vec![
            OsString::from("zmail"),
            OsString::from("draft"),
            OsString::from("list"),
            OsString::from("--superfluous"),
        ];
        let (cli, notes) = parse_cli_forgiving(args).expect("parse");
        assert_eq!(notes.len(), 1);
        match cli.command {
            Commands::Draft { sub } => match sub {
                DraftCmd::List { .. } => {}
                _ => panic!("expected draft list"),
            },
            _ => panic!("expected draft"),
        }
    }

    #[test]
    fn strip_long_exact() {
        let mut a = vec![
            OsString::from("zmail"),
            OsString::from("draft"),
            OsString::from("list"),
            OsString::from("--bogus"),
        ];
        assert!(strip_matching_arg(&mut a, "--bogus"));
        assert_eq!(
            a,
            vec![
                OsString::from("zmail"),
                OsString::from("draft"),
                OsString::from("list"),
            ]
        );
    }

    #[test]
    fn strip_long_equals_form() {
        let mut a = vec![
            OsString::from("zmail"),
            OsString::from("search"),
            OsString::from("q"),
            OsString::from("--bogus=1"),
        ];
        assert!(strip_matching_arg(&mut a, "--bogus"));
        assert_eq!(
            a,
            vec![
                OsString::from("zmail"),
                OsString::from("search"),
                OsString::from("q"),
            ]
        );
    }

    #[test]
    fn strip_short_cluster() {
        let mut a = vec![
            OsString::from("zmail"),
            OsString::from("status"),
            OsString::from("-xj"),
        ];
        assert!(strip_matching_arg(&mut a, "-j"));
        assert_eq!(
            a,
            vec![
                OsString::from("zmail"),
                OsString::from("status"),
                OsString::from("-x"),
            ]
        );
    }
}
