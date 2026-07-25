use std::io::{self, IsTerminal, Write};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use crossterm::style::{Color, ResetColor, SetForegroundColor};
use crossterm::terminal::{Clear, ClearType};
use tokio::task::JoinHandle;

use super::{abbreviate_model, use_color};

struct SpinnerState {
    phase: String,
    model: Option<String>,
    start: Instant,
    active: bool,
}

fn lock_state(state: &Mutex<SpinnerState>) -> MutexGuard<'_, SpinnerState> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Live-updating status line shown during LLM streaming.
///
/// Displays elapsed time and current phase (e.g. `(thinking... 2.3s)`),
/// updated every 200ms. Automatically disabled when stdout is not a terminal.
pub(crate) struct StreamSpinner {
    state: Arc<Mutex<SpinnerState>>,
    handle: Option<JoinHandle<()>>,
    is_terminal: bool,
    cleared: bool,
}

/// Format the spinner display line from current state.
fn format_spinner_line(phase: &str, model: Option<&str>, elapsed_secs: f64) -> String {
    let label = match phase {
        "thinking" => "thinking...",
        "" => "generating...",
        other => other,
    };
    match model {
        Some(m) => format!("({label} {elapsed_secs:.1}s \u{00b7} {m}) "),
        None => format!("({label} {elapsed_secs:.1}s) "),
    }
}

impl StreamSpinner {
    pub(crate) fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(SpinnerState {
                phase: String::new(),
                model: None,
                start: Instant::now(),
                active: false,
            })),
            handle: None,
            is_terminal: io::stdout().is_terminal(),
            cleared: false,
        }
    }

    /// Start the spinner render loop. No-op if stdout is not a terminal.
    pub(crate) fn start(&mut self) {
        if !self.is_terminal {
            return;
        }
        self.cleared = false;
        {
            let mut s = lock_state(&self.state);
            s.start = Instant::now();
            s.active = true;
        }

        let state = Arc::clone(&self.state);
        self.handle = Some(tokio::spawn(async move {
            let mut first = true;
            loop {
                if first {
                    first = false;
                } else {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
                let line = {
                    let s = lock_state(&state);
                    if !s.active {
                        break;
                    }
                    let elapsed = s.start.elapsed().as_secs_f64();
                    let model_abbrev = s.model.as_deref().map(abbreviate_model);
                    format_spinner_line(&s.phase, model_abbrev, elapsed)
                };
                let stdout = io::stdout();
                let mut out = stdout.lock();
                let _ignored = write!(out, "\r");
                _ = crossterm::execute!(out, Clear(ClearType::CurrentLine));
                if use_color() {
                    _ = crossterm::execute!(out, SetForegroundColor(Color::DarkGrey));
                }
                _ = write!(out, "{line}");
                if use_color() {
                    _ = crossterm::execute!(out, ResetColor);
                }
                _ = out.flush();
            }
        }));
    }

    pub(crate) fn set_phase(&self, phase: &str) {
        let mut s = lock_state(&self.state);
        phase.clone_into(&mut s.phase);
    }

    pub(crate) fn set_model(&self, model: Option<String>) {
        let mut s = lock_state(&self.state);
        s.model = model;
    }

    /// Whether the spinner render loop is running.
    pub(crate) fn is_active(&self) -> bool {
        lock_state(&self.state).active
    }

    /// Clear the spinner line and stop the render task.
    pub(crate) async fn clear(&mut self) {
        if self.cleared {
            return;
        }
        self.cleared = true;
        {
            let mut s = lock_state(&self.state);
            s.active = false;
        }
        if let Some(h) = self.handle.take() {
            let _ignored = h.await;
        }
        if self.is_terminal {
            let stdout = io::stdout();
            let mut out = stdout.lock();
            let _ignored = write!(out, "\r");
            _ = crossterm::execute!(out, Clear(ClearType::CurrentLine));
            _ = out.flush();
        }
    }

    /// Stop the spinner (alias for clear). Use when streaming ends without chunks.
    pub(crate) async fn stop(&mut self) {
        self.clear().await;
    }

    /// Restart the spinner for a new LLM round (e.g. after tool execution).
    pub(crate) fn restart(&mut self) {
        self.cleared = false;
        self.start();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_spinner_line_thinking() {
        let line = format_spinner_line("thinking", None, 2.3);
        assert_eq!(line, "(thinking... 2.3s) ");
    }

    #[test]
    fn format_spinner_line_with_model() {
        let line = format_spinner_line("thinking", Some("claude-sonnet-4"), 1.5);
        assert_eq!(line, "(thinking... 1.5s \u{00b7} claude-sonnet-4) ");
    }

    #[test]
    fn format_spinner_line_empty_phase() {
        let line = format_spinner_line("", None, 0.4);
        assert_eq!(line, "(generating... 0.4s) ");
    }

    #[test]
    fn format_spinner_line_custom_phase() {
        let line = format_spinner_line("analyzing", None, 5.0);
        assert_eq!(line, "(analyzing 5.0s) ");
    }

    #[test]
    fn stream_spinner_new_does_not_panic() {
        let spinner = StreamSpinner::new();
        assert!(!spinner.is_active());
    }
}
