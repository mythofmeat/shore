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
#[expect(
    clippy::arithmetic_side_effects,
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::else_if_without_else,
    clippy::float_arithmetic,
    clippy::indexing_slicing,
    clippy::integer_division,
    clippy::let_underscore_must_use,
    clippy::shadow_reuse,
    clippy::shadow_unrelated,
    clippy::string_slice,
    clippy::wildcard_enum_match_arm,
    reason = "the imported TUI renderer remains isolated while its unchecked layout operations are converted"
)]
mod tui;

use std::process::ExitCode;

use cli::{Cli, CliCommand};
use tracing_subscriber::EnvFilter;

fn main() -> ExitCode {
    output::detect_color();

    if let Some(problem) = cli::flag_problem(std::env::args()) {
        return cli::report_flag_problem(&problem);
    }

    let cli = match <Cli as clap::FromArgMatches>::from_arg_matches(
        &cli::grouped_command().get_matches(),
    ) {
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
        return ExitCode::SUCCESS;
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
            .block_on(run::execute(cli.character, cli.addr, command))
            .map(|()| ExitCode::SUCCESS),
        None => rt
            .block_on(tui::run(cli.addr, cli.character))
            .map_err(Into::into),
    };
    match outcome {
        Ok(code) => code,
        Err(e) => {
            if !run::already_reported(e.as_ref()) {
                output::print_error(&e);
            }
            ExitCode::FAILURE
        }
    }
}
