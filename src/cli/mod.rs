mod args;
mod commands;
mod forgiving;
mod triage;
mod util;

pub(crate) type CliResult = Result<(), Box<dyn std::error::Error>>;

pub(crate) fn run() -> CliResult {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    let (cli, notes) = match forgiving::parse_cli_forgiving(args) {
        Ok(v) => v,
        Err((notes, e)) => {
            for n in notes {
                eprintln!("zmail: note: {n}");
            }
            e.exit();
        }
    };
    for n in notes {
        eprintln!("zmail: note: {n}");
    }
    commands::handle_command(cli.command)
}
