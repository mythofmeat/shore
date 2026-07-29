//! LedgerStream: stream wrapper that records on finalization.

use crate::ledger::cache_tracker::CacheTrackers;
use crate::ledger::client::{record_call, CallType};
use crate::ledger::pricing::PricingEngine;
use crate::ledger::store::Ledger;
use crate::llm::types::StreamResult;
use crate::llm::StreamReader;
use std::sync::Arc;
use tracing::error;

/// Owned call metadata carried by a [`LedgerStream`] until finalization, where
/// it is borrowed into a [`crate::ledger::client::RecordCall`].
#[derive(Debug)]
pub(crate) struct CallMeta {
    pub(crate) provider: String,
    pub(crate) api_key_name: Option<String>,
    pub(crate) model: String,
    pub(crate) call_type: CallType,
    pub(crate) character: String,
    pub(crate) thinking_enabled: bool,
    pub(crate) cache_ttl: Option<String>,
    pub(crate) reasoning_effort: Option<String>,
}

pub struct LedgerStream {
    reader: StreamReader,
    meta: CallMeta,
    ledger: Arc<Ledger>,
    pricing: Arc<PricingEngine>,
    cache_trackers: Arc<CacheTrackers>,
    finalized: bool,
}

impl std::fmt::Debug for LedgerStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LedgerStream")
            .field("meta", &self.meta)
            .field("ledger", &self.ledger)
            .field("pricing", &self.pricing)
            .field("cache_trackers", &self.cache_trackers)
            .field("finalized", &self.finalized)
            .finish_non_exhaustive()
    }
}

impl LedgerStream {
    pub(crate) fn new(
        reader: StreamReader,
        meta: CallMeta,
        ledger: Arc<Ledger>,
        pricing: Arc<PricingEngine>,
        cache_trackers: Arc<CacheTrackers>,
    ) -> Self {
        Self {
            reader,
            meta,
            ledger,
            pricing,
            cache_trackers,
            finalized: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_test(
        meta: CallMeta,
        ledger: Arc<Ledger>,
        pricing: Arc<PricingEngine>,
        cache_trackers: Arc<CacheTrackers>,
    ) -> Self {
        let (_write, read) = tokio::io::duplex(1);
        let boxed: Box<dyn tokio::io::AsyncRead + Send + Unpin> = Box::new(read);
        Self::new(
            tokio::io::BufReader::new(boxed),
            meta,
            ledger,
            pricing,
            cache_trackers,
        )
    }

    pub fn reader_mut(&mut self) -> &mut StreamReader {
        &mut self.reader
    }

    /// Record one ledger row for this call from already-resolved fields. All
    /// three terminal paths (`finalize`, `finalize_error`, and the `Drop`
    /// safety net) funnel through here so the recording shape stays identical.
    fn record(
        &self,
        usage: &crate::llm::types::Usage,
        timing: &crate::llm::types::Timing,
        finish_reason: &str,
    ) {
        self.record_as(self.meta.call_type, usage, timing, finish_reason);
    }

    /// As [`Self::record`], but for a call whose type differs from the stream's
    /// — a loop's continuations, which are `tool_loop` even though the stream
    /// that carried them was a `message`.
    fn record_as(
        &self,
        call_type: CallType,
        usage: &crate::llm::types::Usage,
        timing: &crate::llm::types::Timing,
        finish_reason: &str,
    ) {
        record_call(
            &self.ledger,
            &self.pricing,
            &self.cache_trackers,
            crate::ledger::client::RecordCall {
                provider: &self.meta.provider,
                api_key_name: self.meta.api_key_name.clone(),
                model: &self.meta.model,
                call_type,
                character: &self.meta.character,
                usage,
                timing,
                finish_reason,
                thinking_enabled: self.meta.thinking_enabled,
                cache_ttl: self.meta.cache_ttl.clone(),
                reasoning_effort: self.meta.reasoning_effort.clone(),
            },
        );
    }

    /// Record this stream's ledger rows.
    ///
    /// One row per provider call when the sidecar reported a breakdown, in the
    /// order the calls were made. A summed row would misreport the cache: the
    /// tracker reads each row's `cache_read` against the last one's, and a sum
    /// exceeds any single call's, so the following message looks like a
    /// regression and trips `unexpected_write`. Streams with no breakdown —
    /// every non-delegated call — record exactly one row, as before.
    pub fn finalize(&mut self, result: &StreamResult) {
        if result.calls.is_empty() {
            self.record(&result.usage, &result.timing, &result.finish_reason);
        } else {
            for call in &result.calls {
                let call_type = if call.continuation {
                    self.meta.call_type.continuation()
                } else {
                    self.meta.call_type
                };
                self.record_as(call_type, &call.usage, &call.timing, &call.finish_reason);
            }
        }
        self.finalized = true;
    }

    /// Record a failed/aborted call so the ledger has a trace of the attempt
    /// even when `consume()` returns an error.
    ///
    /// When the provider failed mid-stream but had already reported usage
    /// (`LlmError::StreamErrored` — e.g. the Anthropic cache write announced in
    /// `message_start`, which the provider bills before any output), that usage
    /// is recorded so the cost is not silently dropped. All other errors record
    /// zero usage, since nothing was billed.
    pub fn finalize_error(&mut self, err: &crate::llm::LlmError) {
        use crate::llm::types::{Timing, Usage};
        let zero_usage = Usage::default();
        let zero_timing = Timing::default();
        // Only `StreamErrored` carries provider-reported usage (the cache write
        // billed before the failure); every other error means nothing landed.
        let (usage, timing) = if let crate::llm::LlmError::StreamErrored { usage, timing, .. } = err
        {
            (usage.as_ref(), timing)
        } else {
            (&zero_usage, &zero_timing)
        };
        self.record(usage, timing, "error");
        self.finalized = true;
    }

    pub fn is_finalized(&self) -> bool {
        self.finalized
    }
}

impl Drop for LedgerStream {
    fn drop(&mut self) {
        if self.finalized {
            return;
        }
        // Neither `finalize` nor `finalize_error` ran: the consume future was
        // cancelled (the SWP client disconnected, an upstream deadline dropped
        // the generation future, etc.) before reaching a terminal frame.
        // Record the attempt rather than silently losing it — usage is zero
        // because it only arrives in the `done`/`error` frame, which never came,
        // but a `cancelled` row keeps `shore usage` honest about the call having
        // happened. `record_call` is synchronous and self-contained, so it is
        // safe to run from Drop (no runtime, no await).
        error!(
            provider = %self.meta.provider,
            model = %self.meta.model,
            character = %self.meta.character,
            call_type = self.meta.call_type.as_str(),
            "LedgerStream dropped without finalize — recording as cancelled"
        );
        self.record(
            &crate::llm::types::Usage::default(),
            &crate::llm::types::Timing::default(),
            "cancelled",
        );
        self.finalized = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::client::CallType;
    use crate::ledger::pricing::PricingEngine;
    use crate::ledger::store::Ledger;
    use crate::llm::types::{StreamResult, Timing, Usage};
    use std::sync::Arc;

    #[test]
    fn finalize_records_to_ledger() {
        let ledger = Arc::new(Ledger::open_in_memory().unwrap());
        let pricing = Arc::new(PricingEngine::new(Arc::clone(&ledger)));
        let trackers = Arc::new(CacheTrackers::default());

        let mut stream = LedgerStream::new_test(
            CallMeta {
                provider: "anthropic".into(),
                api_key_name: None,
                model: "claude-opus-4-6".into(),
                call_type: CallType::Message,
                character: "aria".into(),
                thinking_enabled: true,
                cache_ttl: None,
                reasoning_effort: None,
            },
            Arc::clone(&ledger),
            pricing,
            trackers,
        );

        let result = StreamResult {
            content: "Hello".into(),
            model: "claude-opus-4-6".into(),
            finish_reason: "end_turn".into(),
            usage: Usage {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_tokens: 80,
                cache_creation_tokens: 20,
                ..Default::default()
            },
            timing: Timing {
                total_ms: 1500,
                time_to_first_token_ms: 200,
            },
            tool_uses: vec![],
            calls: vec![],
            content_blocks: vec![],
        };

        stream.finalize(&result);
        assert!(stream.is_finalized());

        let rows = ledger.recent(1).unwrap();
        assert_eq!(rows.len(), 1);
        let row = rows.first().expect("ledger row should be present");
        assert_eq!(row.input_tokens, 100);
        assert_eq!(row.cache_read_tokens, 80);
        assert_eq!(row.cache_write_tokens, 20);
    }

    /// A delegated loop's calls each get their own row, typed the way the
    /// daemon-driven loop typed them.
    ///
    /// The sum is what the sidecar used to report and what the ledger used to
    /// store. Rows are what the cache tracker reads, and it compares each row's
    /// `cache_read` against the last one's — so a summed read raises the
    /// baseline above anything a single call can reach, and the *next* ordinary
    /// message reads "less" and is flagged `unexpected_write`. Splitting the
    /// rows is what stops the tracker inventing an anomaly.
    #[test]
    fn a_delegated_loop_records_one_row_per_call() {
        let ledger = Arc::new(Ledger::open_in_memory().unwrap());
        let pricing = Arc::new(PricingEngine::new(Arc::clone(&ledger)));
        let trackers = Arc::new(CacheTrackers::default());

        let mut stream = LedgerStream::new_test(
            CallMeta {
                provider: "anthropic".into(),
                api_key_name: None,
                model: "claude-opus-4-6".into(),
                call_type: CallType::Message,
                character: "aria".into(),
                thinking_enabled: true,
                cache_ttl: None,
                reasoning_effort: None,
            },
            Arc::clone(&ledger),
            pricing,
            trackers,
        );

        let call = |read: u64, write: u64, continuation: bool| crate::llm::types::CallRecord {
            usage: Usage {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_tokens: read,
                cache_creation_tokens: write,
                ..Default::default()
            },
            timing: Timing {
                total_ms: 900,
                time_to_first_token_ms: 100,
            },
            finish_reason: if continuation { "end_turn" } else { "tool_use" }.into(),
            continuation,
        };

        let result = StreamResult {
            content: "done".into(),
            model: "claude-opus-4-6".into(),
            finish_reason: "end_turn".into(),
            // The sum, as the sidecar still reports it.
            usage: Usage {
                input_tokens: 30,
                output_tokens: 15,
                cache_read_tokens: 2000 + 2200 + 2400,
                cache_creation_tokens: 600,
                ..Default::default()
            },
            timing: Timing {
                total_ms: 2700,
                time_to_first_token_ms: 100,
            },
            tool_uses: vec![],
            calls: vec![
                call(2000, 200, false),
                call(2200, 200, true),
                call(2400, 200, true),
            ],
            content_blocks: vec![],
        };

        stream.finalize(&result);

        let rows = ledger.recent(10).unwrap();
        assert_eq!(rows.len(), 3, "one row per provider call, not one per loop");
        // `recent` is newest-first; read them in the order the calls happened.
        let ordered: Vec<_> = rows.iter().rev().collect();
        let reads: Vec<u64> = ordered.iter().map(|r| r.cache_read_tokens).collect();
        assert_eq!(reads, vec![2000, 2200, 2400], "no row carries the sum");
        let types: Vec<&str> = ordered.iter().map(|r| r.call_type.as_str()).collect();
        assert_eq!(
            types,
            vec!["message", "tool_loop", "tool_loop"],
            "the opening call is the turn; the rest answer tool results"
        );
    }

    /// Regression: a stream that errors *after* `message_start` (so Anthropic
    /// already processed and billed the cache write) must record that write,
    /// not zeros. Previously `finalize_error` always wrote `Usage::default()`,
    /// silently dropping the most expensive event — a cold-start cache write.
    #[test]
    fn finalize_error_records_partial_usage_from_stream_errored() {
        let ledger = Arc::new(Ledger::open_in_memory().unwrap());
        let pricing = Arc::new(PricingEngine::new(Arc::clone(&ledger)));
        let trackers = Arc::new(CacheTrackers::default());

        let mut stream = LedgerStream::new_test(
            CallMeta {
                provider: "anthropic".into(),
                api_key_name: None,
                model: "claude-opus-4-6".into(),
                call_type: CallType::Message,
                character: "aria".into(),
                thinking_enabled: true,
                cache_ttl: None,
                reasoning_effort: None,
            },
            Arc::clone(&ledger),
            pricing,
            trackers,
        );

        let err = crate::llm::LlmError::StreamErrored {
            message: "connection reset".into(),
            usage: Box::new(Usage {
                input_tokens: 2,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 19_188,
                ..Default::default()
            }),
            timing: Timing {
                total_ms: 800,
                time_to_first_token_ms: 0,
            },
        };

        stream.finalize_error(&err);
        assert!(stream.is_finalized());

        let rows = ledger.recent(1).unwrap();
        let row = rows.first().expect("ledger row should be present");
        assert_eq!(row.finish_reason, "error");
        assert_eq!(
            row.cache_write_tokens, 19_188,
            "the cache write billed before the error must be recorded, not dropped"
        );
        assert_eq!(row.input_tokens, 2);
    }

    /// Errors with no carried usage (failure before any `message_start`, e.g.
    /// `IncompleteStream`) still record zeros — nothing was billed.
    #[test]
    fn finalize_error_without_usage_records_zeros() {
        let ledger = Arc::new(Ledger::open_in_memory().unwrap());
        let pricing = Arc::new(PricingEngine::new(Arc::clone(&ledger)));
        let trackers = Arc::new(CacheTrackers::default());

        let mut stream = LedgerStream::new_test(
            CallMeta {
                provider: "anthropic".into(),
                api_key_name: None,
                model: "claude-opus-4-6".into(),
                call_type: CallType::Message,
                character: "aria".into(),
                thinking_enabled: true,
                cache_ttl: None,
                reasoning_effort: None,
            },
            Arc::clone(&ledger),
            pricing,
            trackers,
        );

        stream.finalize_error(&crate::llm::LlmError::IncompleteStream);

        let rows = ledger.recent(1).unwrap();
        let row = rows.first().expect("ledger row should be present");
        assert_eq!(row.finish_reason, "error");
        assert_eq!(row.cache_write_tokens, 0);
        assert_eq!(row.input_tokens, 0);
    }

    /// A `LedgerStream` whose consume future is cancelled (dropped before
    /// either finalize path runs) must still leave a ledger trace — a
    /// `cancelled` row with zero usage — instead of silently vanishing.
    /// Regression for "LedgerStream dropped without finalize — API call was NOT
    /// recorded".
    #[test]
    fn drop_without_finalize_records_cancelled_row() {
        let ledger = Arc::new(Ledger::open_in_memory().unwrap());
        let pricing = Arc::new(PricingEngine::new(Arc::clone(&ledger)));
        let trackers = Arc::new(CacheTrackers::default());

        {
            let _stream = LedgerStream::new_test(
                CallMeta {
                    provider: "anthropic".into(),
                    api_key_name: None,
                    model: "claude-opus-4-6".into(),
                    call_type: CallType::Message,
                    character: "qifei".into(),
                    thinking_enabled: true,
                    cache_ttl: Some("1h".into()),
                    reasoning_effort: None,
                },
                Arc::clone(&ledger),
                Arc::clone(&pricing),
                Arc::clone(&trackers),
            );
            // Drop here without calling finalize / finalize_error.
        }

        let rows = ledger.recent(1).unwrap();
        let row = rows
            .first()
            .expect("dropped stream must still record a row");
        assert_eq!(row.finish_reason, "cancelled");
        assert_eq!(row.input_tokens, 0);
        assert_eq!(row.output_tokens, 0);
        assert_eq!(row.cache_write_tokens, 0);
        // Zero-usage cancellation must not perturb the cache tracker.
        assert!(trackers.lock().get("qifei").is_none());
    }

    #[test]
    fn finalize_updates_cache_tracker() {
        let ledger = Arc::new(Ledger::open_in_memory().unwrap());
        let pricing = Arc::new(PricingEngine::new(Arc::clone(&ledger)));
        let trackers = Arc::new(CacheTrackers::default());

        let mut stream = LedgerStream::new_test(
            CallMeta {
                provider: "anthropic".into(),
                api_key_name: None,
                model: "claude-opus-4-6".into(),
                call_type: CallType::Message,
                character: "aria".into(),
                thinking_enabled: true,
                cache_ttl: None,
                reasoning_effort: None,
            },
            Arc::clone(&ledger),
            pricing,
            Arc::clone(&trackers),
        );

        let result = StreamResult {
            content: "Hello".into(),
            model: "claude-opus-4-6".into(),
            finish_reason: "end_turn".into(),
            usage: Usage {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_tokens: 0,
                cache_creation_tokens: 500,
                ..Default::default()
            },
            timing: Timing {
                total_ms: 1500,
                time_to_first_token_ms: 200,
            },
            tool_uses: vec![],
            calls: vec![],
            content_blocks: vec![],
        };

        stream.finalize(&result);
        let map = trackers.lock();
        assert_eq!(
            map.get("aria").unwrap().state(),
            crate::ledger::cache_tracker::CacheState::Warm
        );
    }
}
