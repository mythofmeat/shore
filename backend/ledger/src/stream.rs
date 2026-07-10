//! LedgerStream: stream wrapper that records on finalization.

use crate::cache_tracker::CacheTrackers;
use crate::client::{record_call, CallType};
use crate::ledger::Ledger;
use crate::pricing::PricingEngine;
use shore_llm::types::StreamResult;
use shore_llm::StreamReader;
use std::sync::Arc;
use tracing::error;

/// Owned call metadata carried by a [`LedgerStream`] until finalization, where
/// it is borrowed into a [`crate::client::RecordCall`].
#[derive(Debug)]
pub(crate) struct CallMeta {
    pub(crate) provider: String,
    pub(crate) api_key_name: Option<String>,
    pub(crate) model: String,
    pub(crate) call_type: CallType,
    pub(crate) character: String,
    pub(crate) thinking_enabled: bool,
    pub(crate) cache_ttl: Option<String>,
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
        usage: &shore_llm::types::Usage,
        timing: &shore_llm::types::Timing,
        finish_reason: &str,
    ) {
        record_call(
            &self.ledger,
            &self.pricing,
            &self.cache_trackers,
            crate::client::RecordCall {
                provider: &self.meta.provider,
                api_key_name: self.meta.api_key_name.clone(),
                model: &self.meta.model,
                call_type: self.meta.call_type,
                character: &self.meta.character,
                usage,
                timing,
                finish_reason,
                thinking_enabled: self.meta.thinking_enabled,
                cache_ttl: self.meta.cache_ttl.clone(),
            },
        );
    }

    pub fn finalize(&mut self, result: &StreamResult) {
        self.record(&result.usage, &result.timing, &result.finish_reason);
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
    pub fn finalize_error(&mut self, err: &shore_llm::LlmError) {
        use shore_llm::types::{Timing, Usage};
        let zero_usage = Usage::default();
        let zero_timing = Timing::default();
        // Only `StreamErrored` carries provider-reported usage (the cache write
        // billed before the failure); every other error means nothing landed.
        let (usage, timing) = if let shore_llm::LlmError::StreamErrored { usage, timing, .. } = err
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
            &shore_llm::types::Usage::default(),
            &shore_llm::types::Timing::default(),
            "cancelled",
        );
        self.finalized = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::CallType;
    use crate::ledger::Ledger;
    use crate::pricing::PricingEngine;
    use shore_llm::types::{StreamResult, Timing, Usage};
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
            },
            Arc::clone(&ledger),
            pricing,
            trackers,
        );

        let err = shore_llm::LlmError::StreamErrored {
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
            },
            Arc::clone(&ledger),
            pricing,
            trackers,
        );

        stream.finalize_error(&shore_llm::LlmError::IncompleteStream);

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
            content_blocks: vec![],
        };

        stream.finalize(&result);
        let map = trackers.lock();
        assert_eq!(
            map.get("aria").unwrap().state(),
            crate::cache_tracker::CacheState::Warm
        );
    }
}
