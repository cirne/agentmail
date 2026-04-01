mod args;
mod commands;
mod triage;
mod util;

use clap::Parser;

pub(crate) type CliResult = Result<(), Box<dyn std::error::Error>>;

pub(crate) fn run() -> CliResult {
    let cli = args::Cli::parse();
    commands::handle_command(cli.command)
}
