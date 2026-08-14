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
mod images;
mod output;
mod run;
mod state;
#[cfg(test)]
mod test_env;

use std::process::ExitCode;

use cli::{Cli, CliCommand};
use tracing_subscriber::EnvFilter;

fn main() -> ExitCode {
    output::detect_color();

    if let Some(problem) = cli::flag_problem(std::env::args()) {
        return cli::report_flag_problem(&problem);
    }

    let cli = <Cli as clap::Parser>::parse();

    // Completion queries must never print to stderr — fish feeds both
    // streams into the prompt, and any stray tracing line would be
    // offered as a candidate. Silence everything for this one path.
    let default_filter = if matches!(cli.command, CliCommand::Complete { .. }) {
        "off"
    } else {
        "warn"
    };

    // CLI logs to stderr so stdout stays clean for command output.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_filter)),
        )
        .with_target(true)
        .with_writer(std::io::stderr)
        .init();

    // Handle local-only commands that don't need a daemon connection.
    if let CliCommand::Completions { shell } = &cli.command {
        cli::print_completions(*shell);
        return ExitCode::SUCCESS;
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

    let outcome = rt.block_on(run::execute(cli));
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            // A server error was printed where it happened, with its protocol
            // code; printing it here too is the same sentence twice.
            if !run::already_reported(e.as_ref()) {
                output::print_error(&e);
            }
            ExitCode::FAILURE
        }
    }
}
