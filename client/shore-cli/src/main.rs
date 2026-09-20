macro_rules! cli_out {
    () => {
        $crate::output::write_stdout_line(format_args!(""))
    };
    ($($arg:tt)*) => {
        $crate::output::write_stdout_line(format_args!($($arg)*))
    };
}

macro_rules! cli_write {
    ($($arg:tt)*) => {
        $crate::output::write_stdout(format_args!($($arg)*))
    };
}

macro_rules! cli_err {
    () => {
        $crate::output::write_stderr_line(format_args!(""))
    };
    ($($arg:tt)*) => {
        $crate::output::write_stderr_line(format_args!($($arg)*))
    };
}

mod cli;
mod output;
mod run;
mod state;
mod terminal_images;
#[cfg(test)]
mod test_env;
mod tui;

use std::process::ExitCode;

use cli::{Cli, CliCommand};
use tracing_subscriber::EnvFilter;

fn main() -> ExitCode {
    output::detect_color();

    if let Some(problem) = cli::flag_problem(std::env::args()) {
        return cli::report_flag_problem(&problem);
    }

    let matches = cli::grouped_command().get_matches();
    let thread_from_env =
        matches.value_source("thread") == Some(clap::parser::ValueSource::EnvVariable);
    let cli = match <Cli as clap::FromArgMatches>::from_arg_matches(&matches) {
        Ok(parsed) => parsed,
        Err(e) => e.exit(),
    };

    let default_filter = if matches!(cli.command, Some(CliCommand::Complete { .. })) {
        "off"
    } else {
        "warn"
    };

    if let Some(CliCommand::Completions { shell }) = &cli.command {
        cli::print_completions(*shell);
        return match output::finish_stdout() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                output::print_error(&error);
                ExitCode::FAILURE
            }
        };
    }

    if cli.command.is_some() {
        tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| EnvFilter::new(default_filter)),
            )
            .with_target(true)
            .with_writer(std::io::stderr)
            .init();
    }

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            output::print_error(&format!("failed to build tokio runtime: {e}"));
            return ExitCode::FAILURE;
        }
    };

    let outcome: Result<ExitCode, Box<dyn std::error::Error>> = match cli.command {
        Some(command) => rt
            .block_on(run::execute(
                cli.character,
                cli.thread,
                thread_from_env,
                cli.addr,
                command,
            ))
            .map(|()| ExitCode::SUCCESS),
        None => rt
            .block_on(tui::run(cli.addr, cli.character, cli.thread))
            .map_err(Into::into),
    };
    match outcome.and_then(|code| output::finish_stdout().map(|()| code).map_err(Into::into)) {
        Ok(code) => code,
        Err(e) => {
            if !run::already_reported(e.as_ref()) {
                output::print_error(&e);
            }
            ExitCode::FAILURE
        }
    }
}
