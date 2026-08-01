//! The shape every tool loop has in common.
//!
//! Shore ran three hand-written copies of this control flow — the chat path
//! (`engine::tools::run_tool_loop`, also used by sub-agents), the compaction
//! pass, and the dreaming librarian. All three say the same thing: call the
//! model, run whatever tools it asked for, feed the results back, repeat until
//! it stops asking or a cap is reached.
//!
//! They had already drifted on the one part of that which is a genuine policy
//! choice: whether a loop that hits its cap gives the model a final turn to see
//! the results it just asked for. The chat path does — its return value is the
//! reply the user reads, so it has to be a real turn. The background passes do
//! not — they harvest their output from state accumulated during the loop, and
//! a closing turn would be a call whose answer nobody reads.
//!
//! That difference was expressed by where each copy happened to put its `if`:
//! before the dispatch in one, after it in another, at the top of the loop in
//! the third. Reading any one of them told you nothing about whether the
//! placement was deliberate. It is now [`CapBehavior`], named and chosen at the
//! call site.

use async_trait::async_trait;
use shore_common::protocol::types::ContentBlock;

use crate::llm::types::{LlmRequest, ToolUseEvent, WireBlock, WireMessage, WireRole};

/// The tool calls in a turn's content blocks.
///
/// The chat path gets these from the stream consumer as it decodes; the
/// background passes read them back off the finished response.
pub(crate) fn tool_uses_in(blocks: &[ContentBlock]) -> Vec<ToolUseEvent> {
    crate::content_util::extract_tool_uses(blocks)
        .into_iter()
        .map(|(id, name, input)| ToolUseEvent { id, name, input })
        .collect()
}

/// Whether a loop that hits its iteration cap gets one more model turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CapBehavior {
    /// Stop the moment the cap is reached. The tool results from the final
    /// round are appended to the request but never sent — the caller's output
    /// comes from what it accumulated, not from a closing message.
    StopAfterDispatch,
    /// Send the final round's tool results and let the model answer. Costs one
    /// extra call, and is what a caller whose return value is a user-visible
    /// reply needs.
    CloseWithFinalTurn,
}

/// Why the loop stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LoopStop {
    /// The model returned a turn that asked for no tools.
    ModelDone,
    /// The iteration cap was reached.
    CapReached,
}

/// How the loop ended, plus the turn it ended on.
pub(crate) struct LoopOutcome<T> {
    pub stop: LoopStop,
    pub last_turn: T,
}

/// The parts of a tool loop that genuinely differ between callers.
///
/// Appending the assistant turn is the driver's job, not [`run`]'s, and each
/// caller does it at a different point: the background passes append inside
/// `call_model`, because every turn they see comes from there; the chat path
/// appends inside `dispatch`, because its first turn was streamed by its caller
/// and never passes through `call_model` at all. Only the tool-result turn is
/// identical everywhere, so that is the one [`run`] owns.
#[async_trait]
pub(crate) trait ToolLoopDriver: Send {
    /// The caller's own response type — a `StreamResult` on the chat path, a
    /// `GenerateResponse` on the background ones.
    type Turn: Send + Sync;
    type Error;

    fn finish_reason(turn: &Self::Turn) -> &str;
    fn tool_uses(turn: &Self::Turn) -> Vec<ToolUseEvent>;

    /// Call the model with the current request.
    async fn call_model(&mut self, request: &mut LlmRequest) -> Result<Self::Turn, Self::Error>;

    /// Run one round of tool uses and return their result blocks, in the order
    /// the model asked for them. Tool failures come back as blocks with
    /// `is_error` set, never as an `Err` — a failed tool is something the model
    /// is told about, not something that ends the loop.
    ///
    /// `turn` is the response that asked for these tools, passed because every
    /// caller needs it: to append the assistant turn, to emit a stream
    /// boundary, or to pair a transcript row with the tools it went on to call.
    async fn dispatch(
        &mut self,
        request: &mut LlmRequest,
        turn: &Self::Turn,
        uses: Vec<ToolUseEvent>,
    ) -> Vec<WireBlock>;
}

/// Drive a tool loop to completion.
///
/// `initial` is the turn the loop starts from, for callers that already made
/// the first model call before entering (the chat path streams it, so the
/// caller has it in hand). `None` means make that call here.
///
/// `max_iterations` counts *dispatch rounds*, not model calls. `None` is
/// unlimited, so the only exit is the model ending cleanly or an error.
pub(crate) async fn run<D: ToolLoopDriver>(
    driver: &mut D,
    request: &mut LlmRequest,
    initial: Option<D::Turn>,
    max_iterations: Option<u32>,
    cap: CapBehavior,
) -> Result<LoopOutcome<D::Turn>, D::Error> {
    let mut turn = match initial {
        Some(turn) => turn,
        None => driver.call_model(request).await?,
    };
    let mut iteration: u32 = 0;

    loop {
        let uses = D::tool_uses(&turn);
        if uses.is_empty() || D::finish_reason(&turn) != "tool_use" {
            return Ok(LoopOutcome {
                stop: LoopStop::ModelDone,
                last_turn: turn,
            });
        }

        // Reachable only for `max_iterations = Some(0)`: every other path
        // returns below the moment the cap is met, so the loop never comes back
        // around with it already reached. Without this, a cap of zero would run
        // one round — which is what the compaction copy did.
        if max_iterations.is_some_and(|max| iteration >= max) {
            return Ok(LoopOutcome {
                stop: LoopStop::CapReached,
                last_turn: turn,
            });
        }

        let results = driver.dispatch(request, &turn, uses).await;
        request
            .messages
            .push(WireMessage::new(WireRole::User, results));
        iteration = iteration.saturating_add(1);

        let cap_reached = max_iterations.is_some_and(|max| iteration >= max);
        if cap_reached && cap == CapBehavior::StopAfterDispatch {
            return Ok(LoopOutcome {
                stop: LoopStop::CapReached,
                last_turn: turn,
            });
        }

        turn = driver.call_model(request).await?;

        if cap_reached {
            return Ok(LoopOutcome {
                stop: LoopStop::CapReached,
                last_turn: turn,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A turn the fake driver hands back: does it ask for tools or not?
    ///
    /// `finish_reason` is carried separately rather than derived, because the
    /// loop checks *both* it and the block list and the two can disagree in
    /// production — a provider may return tool_use blocks alongside `end_turn`,
    /// or claim `tool_use` having asked for nothing. A fake that ties them
    /// together cannot tell the two checks apart; see `FinishReasonMode`.
    #[derive(Clone)]
    struct FakeTurn {
        asks_for_tools: bool,
        finish_reason: Option<&'static str>,
        label: String,
    }

    /// Records the exact interleaving of model calls and dispatch rounds, which
    /// is the whole behaviour under test.
    /// Whether the fake's `finish_reason` tracks its block list or contradicts
    /// it. `Natural` is what a well-behaved provider does; the other two are the
    /// disagreements the loop's two-part check exists to survive.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum FinishReasonMode {
        Natural,
        AlwaysEndTurn,
        AlwaysToolUse,
    }

    #[derive(Default)]
    struct FakeDriver {
        /// How many more turns should ask for tools before the model gives up.
        tool_turns_remaining: u32,
        /// `None` behaves as `Natural`, which is what the hand-written tests
        /// below want.
        finish_reason_mode: Option<FinishReasonMode>,
        calls: u32,
        dispatches: u32,
        log: Vec<String>,
    }

    #[async_trait]
    impl ToolLoopDriver for FakeDriver {
        type Turn = FakeTurn;
        type Error = ();

        fn finish_reason(turn: &Self::Turn) -> &str {
            turn.finish_reason.unwrap_or(if turn.asks_for_tools {
                "tool_use"
            } else {
                "end_turn"
            })
        }

        fn tool_uses(turn: &Self::Turn) -> Vec<ToolUseEvent> {
            if turn.asks_for_tools {
                vec![ToolUseEvent {
                    id: "tu".into(),
                    name: "read".into(),
                    input: json!({}),
                }]
            } else {
                vec![]
            }
        }

        async fn call_model(
            &mut self,
            _request: &mut LlmRequest,
        ) -> Result<Self::Turn, Self::Error> {
            self.calls = self.calls.saturating_add(1);
            let asks_for_tools = self.tool_turns_remaining > 0;
            self.tool_turns_remaining = self.tool_turns_remaining.saturating_sub(1);
            let label = format!("call{}", self.calls);
            self.log.push(label.clone());
            Ok(FakeTurn {
                asks_for_tools,
                finish_reason: match self.finish_reason_mode {
                    None | Some(FinishReasonMode::Natural) => None,
                    Some(FinishReasonMode::AlwaysEndTurn) => Some("end_turn"),
                    Some(FinishReasonMode::AlwaysToolUse) => Some("tool_use"),
                },
                label,
            })
        }

        async fn dispatch(
            &mut self,
            _request: &mut LlmRequest,
            _turn: &Self::Turn,
            _uses: Vec<ToolUseEvent>,
        ) -> Vec<WireBlock> {
            self.dispatches = self.dispatches.saturating_add(1);
            self.log.push(format!("dispatch{}", self.dispatches));
            vec![WireBlock::Text {
                text: "result".into(),
            }]
        }
    }

    fn empty_request() -> LlmRequest {
        LlmRequest {
            sdk: shore_common::config::models::Sdk::Anthropic,
            model: "test".into(),
            api_key: "k".into(),
            api_key_name: None,
            base_url: None,
            messages: vec![],
            system: Vec::new(),
            tools: None,
            max_tokens: 1024,
            temperature: None,
            top_p: None,
            provider_options: None,
            provider_key: None,
            replay_prior_thinking: shore_common::config::app::ThinkingReplay::All,
            rid: None,
            forensic_character: None,
            retain_long: false,
            tool_rpc: None,
            max_tool_iterations: None,
            keepalive_interval: None,
        }
    }

    async fn drive(
        tool_turns: u32,
        max: Option<u32>,
        cap: CapBehavior,
    ) -> (FakeDriver, LoopStop, String) {
        let mut driver = FakeDriver {
            tool_turns_remaining: tool_turns,
            ..FakeDriver::default()
        };
        let mut request = empty_request();
        let outcome = run(&mut driver, &mut request, None, max, cap)
            .await
            .unwrap_or_else(|()| panic!("fake driver never errors"));
        let last = outcome.last_turn.label.clone();
        (driver, outcome.stop, last)
    }

    #[tokio::test]
    async fn a_model_that_asks_for_nothing_never_dispatches() {
        let (driver, stop, last) = drive(0, None, CapBehavior::CloseWithFinalTurn).await;
        assert_eq!(stop, LoopStop::ModelDone);
        assert_eq!(driver.dispatches, 0);
        assert_eq!(driver.calls, 1);
        assert_eq!(last, "call1");
    }

    #[tokio::test]
    async fn an_uncapped_loop_runs_until_the_model_stops_asking() {
        let (driver, stop, _) = drive(3, None, CapBehavior::StopAfterDispatch).await;
        assert_eq!(stop, LoopStop::ModelDone);
        assert_eq!(driver.dispatches, 3);
        // Three tool turns plus the closing one.
        assert_eq!(driver.calls, 4);
    }

    #[tokio::test]
    async fn closing_with_a_final_turn_costs_one_more_call_than_stopping() {
        // The whole difference between the two behaviours, on the same input.
        let (closing, closing_stop, closing_last) =
            drive(10, Some(2), CapBehavior::CloseWithFinalTurn).await;
        let (stopping, stopping_stop, stopping_last) =
            drive(10, Some(2), CapBehavior::StopAfterDispatch).await;

        assert_eq!(closing_stop, LoopStop::CapReached);
        assert_eq!(stopping_stop, LoopStop::CapReached);

        // Both run exactly `max` dispatch rounds — the cap counts dispatches.
        assert_eq!(closing.dispatches, 2);
        assert_eq!(stopping.dispatches, 2);

        // They differ by the trailing call, and therefore by which turn the
        // caller gets back.
        assert_eq!(closing.calls, 3);
        assert_eq!(stopping.calls, 2);
        assert_eq!(closing_last, "call3");
        assert_eq!(stopping_last, "call2");

        assert_eq!(
            stopping.log,
            vec!["call1", "dispatch1", "call2", "dispatch2"]
        );
        assert_eq!(
            closing.log,
            vec!["call1", "dispatch1", "call2", "dispatch2", "call3"]
        );
    }

    #[tokio::test]
    async fn the_cap_counts_dispatch_rounds_not_model_calls() {
        let (driver, stop, _) = drive(10, Some(1), CapBehavior::StopAfterDispatch).await;
        assert_eq!(stop, LoopStop::CapReached);
        assert_eq!(driver.dispatches, 1);
        assert_eq!(driver.calls, 1);
    }

    #[tokio::test]
    async fn a_cap_of_zero_dispatches_nothing() {
        // The three originals disagreed here: the chat copy ran no rounds, the
        // dreaming copy did not even call the model, and the compaction copy
        // ran one round — exceeding its own cap, because it only checked after
        // dispatching. A cap of zero means zero.
        for cap in [
            CapBehavior::StopAfterDispatch,
            CapBehavior::CloseWithFinalTurn,
        ] {
            let (driver, stop, _) = drive(10, Some(0), cap).await;
            assert_eq!(stop, LoopStop::CapReached);
            assert_eq!(driver.dispatches, 0, "{cap:?} must dispatch nothing");
        }
    }

    #[tokio::test]
    async fn a_model_that_finishes_early_beats_the_cap() {
        // Cap is 5 but the model stops after one round: no CapReached, and no
        // trailing call beyond the one that ended it.
        let (driver, stop, _) = drive(1, Some(5), CapBehavior::CloseWithFinalTurn).await;
        assert_eq!(stop, LoopStop::ModelDone);
        assert_eq!(driver.dispatches, 1);
        assert_eq!(driver.calls, 2);
    }

    #[tokio::test]
    async fn an_initial_turn_replaces_the_first_call() {
        // The chat path streams its first turn before entering the loop.
        let mut driver = FakeDriver {
            tool_turns_remaining: 0,
            ..FakeDriver::default()
        };
        let mut request = empty_request();
        let outcome = run(
            &mut driver,
            &mut request,
            Some(FakeTurn {
                asks_for_tools: false,
                finish_reason: None,
                label: "seeded".into(),
            }),
            None,
            CapBehavior::CloseWithFinalTurn,
        )
        .await
        .unwrap_or_else(|()| panic!("fake driver never errors"));

        assert_eq!(outcome.stop, LoopStop::ModelDone);
        assert_eq!(outcome.last_turn.label, "seeded");
        assert_eq!(driver.calls, 0, "the seeded turn must not trigger a call");
    }

    #[tokio::test]
    async fn every_dispatch_appends_exactly_one_user_turn() {
        let mut driver = FakeDriver {
            tool_turns_remaining: 2,
            ..FakeDriver::default()
        };
        let mut request = empty_request();
        _ = run(
            &mut driver,
            &mut request,
            None,
            None,
            CapBehavior::StopAfterDispatch,
        )
        .await;

        let user_turns = request
            .messages
            .iter()
            .filter(|m| m.role == WireRole::User)
            .count();
        assert_eq!(user_turns, 2, "one tool-result turn per dispatch round");
    }

    /// Generate the parity fixture the TypeScript loop is replayed against.
    ///
    /// Writes only when `SHORE_FIXTURE_OUT` is set, so a normal `cargo test`
    /// never touches the frozen file. Sweeps every dimension the loop branches
    /// on — seeded turn or not, how long the model keeps asking, the cap, and
    /// which cap behaviour — because the interesting cases are the corners:
    /// a cap of zero, a cap the model beats, and the trailing call that
    /// `CloseWithFinalTurn` spends and `StopAfterDispatch` does not.
    #[tokio::test]
    async fn generate_tool_loop_parity_fixture() {
        let Ok(out) = std::env::var("SHORE_FIXTURE_OUT") else {
            return;
        };

        let mut cases = Vec::new();
        for mode in [
            FinishReasonMode::Natural,
            FinishReasonMode::AlwaysEndTurn,
            FinishReasonMode::AlwaysToolUse,
        ] {
            for initial in [None, Some(false), Some(true)] {
                for tool_turns in [0_u32, 1, 2, 3, 10] {
                    for max in [None, Some(0_u32), Some(1), Some(2), Some(3)] {
                        for cap in [
                            CapBehavior::StopAfterDispatch,
                            CapBehavior::CloseWithFinalTurn,
                        ] {
                            let mut driver = FakeDriver {
                                tool_turns_remaining: tool_turns,
                                finish_reason_mode: Some(mode),
                                ..FakeDriver::default()
                            };
                            let mut request = empty_request();
                            let seeded = initial.map(|asks_for_tools| FakeTurn {
                                asks_for_tools,
                                finish_reason: match mode {
                                    FinishReasonMode::Natural => None,
                                    FinishReasonMode::AlwaysEndTurn => Some("end_turn"),
                                    FinishReasonMode::AlwaysToolUse => Some("tool_use"),
                                },
                                label: "seeded".into(),
                            });
                            let outcome = run(&mut driver, &mut request, seeded, max, cap)
                                .await
                                .unwrap_or_else(|()| panic!("fake driver never errors"));

                            cases.push(json!({
                                "finish_reason_mode": match mode {
                                    FinishReasonMode::Natural => "natural",
                                    FinishReasonMode::AlwaysEndTurn => "always_end_turn",
                                    FinishReasonMode::AlwaysToolUse => "always_tool_use",
                                },
                                "initial": match initial {
                                    None => "none",
                                    Some(false) => "seeded_end_turn",
                                    Some(true) => "seeded_tool_use",
                                },
                                "tool_turns": tool_turns,
                                "max_iterations": max,
                                "cap_behavior": match cap {
                                    CapBehavior::StopAfterDispatch => "stop_after_dispatch",
                                    CapBehavior::CloseWithFinalTurn => "close_with_final_turn",
                                },
                                "stop": match outcome.stop {
                                    LoopStop::ModelDone => "model_done",
                                    LoopStop::CapReached => "cap_reached",
                                },
                                "last_turn": outcome.last_turn.label,
                                "model_calls": driver.calls,
                                "dispatch_rounds": driver.dispatches,
                                "log": driver.log,
                                "user_turns_appended": request
                                    .messages
                                    .iter()
                                    .filter(|m| m.role == WireRole::User)
                                    .count(),
                            }));
                        }
                    }
                }
            }
        }

        let doc = json!({
            "_comment": [
                "NOT YET FROZEN. Generated by `generate_tool_loop_parity_fixture`",
                "in crates/daemon/src/engine/tool_loop.rs, driving the real `run`",
                "through a fake driver that records the exact interleaving of",
                "model calls and dispatch rounds. That generator still exists and",
                "still runs, because the Rust loop it characterises has not been",
                "deleted yet — only the control flow has been ported. It freezes",
                "in the commit that removes the daemon-driven loop, and the header",
                "changes to say so then.",
                "Regenerate only from a green daemon tree; dev-ts is red, so use",
                "the worktree at the last green commit.",
                "Replayed by llm-sidecar/tests/tool_loop_parity.test.ts.",
                "The cap counts DISPATCH ROUNDS, not model calls, and",
                "close_with_final_turn spends one extra call after the cap so the",
                "model can answer with the last tool results in hand. The AI SDK's",
                "stepCountIs() counts steps and does neither, so this is the file",
                "that says what the daemon actually did."
            ],
            "cases": cases,
        });

        std::fs::write(
            &out,
            format!("{}\n", serde_json::to_string_pretty(&doc).unwrap()),
        )
        .unwrap_or_else(|e| panic!("write {out}: {e}"));
    }
}
