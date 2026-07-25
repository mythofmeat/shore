//! Model pricing via OpenRouter API with local DB cache.

use crate::ledger::convert::u64_to_f64;
use crate::ledger::store::Ledger;
use crate::ledger::sync::lock_or_recover;
use chrono::Utc;
use rusqlite::params;
use serde_json::Value;
use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex};
use tracing::{debug, info, instrument, warn};

/// Anthropic 1h cache TTL write price is 2× input price (5min price is 1.25× input).
/// Multiplier from 5min price to 1h price: 2.0 / 1.25 = 1.6.
const ANTHROPIC_1H_CACHE_WRITE_MULTIPLIER: f64 = 1.6;

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ModelPricing {
    pub input_per_token: f64,
    pub output_per_token: f64,
    pub cache_read_per_token: f64,
    pub cache_write_per_token: f64,
}

#[derive(Debug, Clone)]
pub struct CostBreakdown {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub total: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct CostRequest<'req> {
    pub provider: &'req str,
    pub model: &'req str,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_ttl: Option<&'req str>,
}

// ── PricingEngine ────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct PricingEngine {
    ledger: Arc<Ledger>,
    memory_cache: Mutex<HashMap<String, ModelPricing>>,
}

impl PricingEngine {
    pub fn new(ledger: Arc<Ledger>) -> Self {
        Self {
            ledger,
            memory_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Write pricing to both DB and memory cache.
    pub fn store_pricing(
        &self,
        model_id: &str,
        pricing: &ModelPricing,
    ) -> Result<(), rusqlite::Error> {
        let started = std::time::Instant::now();
        self.ledger.with_conn(|conn| {
            let _ignored = conn.execute(
                r"INSERT OR REPLACE INTO pricing
                    (model_id, input_per_token, output_per_token,
                     cache_read_per_token, cache_write_per_token, fetched_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    model_id,
                    pricing.input_per_token,
                    pricing.output_per_token,
                    pricing.cache_read_per_token,
                    pricing.cache_write_per_token,
                    Utc::now().to_rfc3339(),
                ],
            )?;
            Ok(())
        })?;

        self.with_memory_cache_mut(|cache| {
            let _ignored = cache.insert(model_id.to_owned(), pricing.clone());
        });
        debug!(model_id, elapsed = ?started.elapsed(), "pricing stored");
        Ok(())
    }

    /// Check memory cache first, then DB. On DB hit, populate memory cache.
    pub fn get_cached_pricing(
        &self,
        model_id: &str,
    ) -> Result<Option<ModelPricing>, rusqlite::Error> {
        let memory_lookup_started = std::time::Instant::now();
        if let Some(pricing) = self.with_memory_cache(|cache| cache.get(model_id).cloned()) {
            debug!(
                model_id,
                elapsed = ?memory_lookup_started.elapsed(),
                "pricing memory cache hit"
            );
            return Ok(Some(pricing));
        }
        debug!(
            model_id,
            elapsed = ?memory_lookup_started.elapsed(),
            "pricing memory cache miss"
        );

        let db_lookup_started = std::time::Instant::now();
        let result = self.ledger.with_conn(|conn| {
            let mut stmt = conn.prepare(
                r"SELECT input_per_token, output_per_token,
                          cache_read_per_token, cache_write_per_token
                   FROM pricing WHERE model_id = ?1",
            )?;
            stmt.query_row(params![model_id], |row| {
                Ok(ModelPricing {
                    input_per_token: row.get(0)?,
                    output_per_token: row.get(1)?,
                    cache_read_per_token: row.get(2)?,
                    cache_write_per_token: row.get(3)?,
                })
            })
            .optional()
        })?;
        debug!(
            model_id,
            hit = result.is_some(),
            elapsed = ?db_lookup_started.elapsed(),
            "pricing DB cache lookup complete"
        );

        // Populate memory cache on DB hit
        if let Some(ref p) = result {
            self.with_memory_cache_mut(|cache| {
                let _ignored = cache.insert(model_id.to_owned(), p.clone());
            });
        }

        Ok(result)
    }

    /// HTTP GET to OpenRouter API to fetch per-token pricing.
    /// The 1-hour cache write multiplier for Anthropic is pre-computed at fetch time.
    #[instrument(skip(self))]
    pub async fn fetch_pricing(
        &self,
        provider: &str,
        model: &str,
    ) -> Result<Option<ModelPricing>, Box<dyn Error + Send + Sync>> {
        let model_id = to_openrouter_id(provider, model);
        info!(model_id, "Fetching pricing from OpenRouter");

        if let Some(p) = self.fetch_and_cache_catalog(&model_id).await? {
            return Ok(Some(p));
        }

        warn!(model_id, "Model not found in OpenRouter catalog");
        Ok(None)
    }

    async fn fetch_and_cache_catalog(
        &self,
        target_model_id: &str,
    ) -> Result<Option<ModelPricing>, Box<dyn Error + Send + Sync>> {
        let url = "https://openrouter.ai/api/v1/models";
        let resp = reqwest::get(url).await?;
        if !resp.status().is_success() {
            warn!(status = %resp.status(), "OpenRouter catalog fetch failed");
            return Ok(None);
        }

        let body: Value = resp.json().await?;
        let Some(models) = body.get("data").and_then(|d| d.as_array()) else {
            warn!("OpenRouter catalog response missing data array");
            return Ok(None);
        };

        let mut result: Option<ModelPricing> = None;

        for m in models {
            let Some(id) = m.get("id").and_then(|v| v.as_str()) else {
                continue;
            };

            let Some(pricing_obj) = m.get("pricing") else {
                continue;
            };

            let input = parse_price(pricing_obj.get("prompt"));
            let output = parse_price(pricing_obj.get("completion"));
            let cache_read = parse_price(
                pricing_obj
                    .get("input_cache_read")
                    .or_else(|| pricing_obj.get("cache_read")),
            );
            let cache_write = parse_price(
                pricing_obj
                    .get("input_cache_write")
                    .or_else(|| pricing_obj.get("cache_write")),
            );

            let pricing = ModelPricing {
                input_per_token: input,
                output_per_token: output,
                cache_read_per_token: cache_read,
                cache_write_per_token: cache_write,
            };

            if id == target_model_id {
                result = Some(pricing.clone());
            }

            if let Err(e) = self.store_pricing(id, &pricing) {
                warn!(model_id = id, error = %e, "Failed to cache pricing for model");
            }
        }

        info!(
            model_count = models.len(),
            found = result.is_some(),
            "OpenRouter catalog cached"
        );
        Ok(result)
    }

    /// Try cached pricing, then fetch from OpenRouter. Returns None if unavailable.
    #[instrument(skip(self))]
    pub async fn get_or_fetch(&self, provider: &str, model: &str) -> Option<ModelPricing> {
        let model_id = to_openrouter_id(provider, model);

        match self.get_cached_pricing(&model_id) {
            Ok(Some(p)) => {
                debug!(model_id, "pricing cache hit");
                return Some(p);
            }
            Err(e) => {
                warn!(error = %e, "pricing DB read failed");
            }
            Ok(None) => {
                debug!(model_id, "pricing cache miss, fetching from OpenRouter");
            }
        }

        match self.fetch_pricing(provider, model).await {
            Ok(p) => p,
            Err(e) => {
                warn!(error = %e, model_id, "pricing fetch failed");
                None
            }
        }
    }

    /// Multiply tokens by per-token prices. Returns None if pricing unavailable.
    /// `cache_ttl`: "5m" or "1h" (default "1h" if None). Selects the pre-computed
    /// cache write price for the appropriate TTL tier.
    #[expect(
        clippy::float_arithmetic,
        reason = "pricing multiplies f64 per-token catalog rates by token counts and sums cost breakdowns"
    )]
    pub fn calculate_cost(
        &self,
        request: CostRequest<'_>,
    ) -> Result<Option<CostBreakdown>, rusqlite::Error> {
        let model_id = to_openrouter_id(request.provider, request.model);
        let Some(pricing) = self.get_cached_pricing(&model_id)? else {
            return Ok(None);
        };

        let input = pricing.input_per_token * u64_to_f64(request.input_tokens);
        let output = pricing.output_per_token * u64_to_f64(request.output_tokens);
        let cache_read = pricing.cache_read_per_token * u64_to_f64(request.cache_read_tokens);

        let mut cache_write =
            pricing.cache_write_per_token * u64_to_f64(request.cache_write_tokens);
        // Native Anthropic 1h cache writes cost 1.6× the 5-minute price.
        // OpenRouter-routed Anthropic rows use OpenRouter's catalog price as
        // billed, so do not apply Anthropic's native TTL multiplier there.
        if request.provider == "anthropic" && request.cache_ttl.unwrap_or("1h") == "1h" {
            cache_write *= ANTHROPIC_1H_CACHE_WRITE_MULTIPLIER;
        }

        Ok(Some(CostBreakdown {
            input,
            output,
            cache_read,
            cache_write,
            total: input + output + cache_read + cache_write,
        }))
    }

    /// Delete all rows from pricing table and clear memory cache.
    pub fn clear_cache(&self) -> Result<(), rusqlite::Error> {
        self.ledger.with_conn(|conn| {
            let _ignored = conn.execute("DELETE FROM pricing", [])?;
            Ok(())
        })?;
        self.with_memory_cache_mut(HashMap::clear);
        Ok(())
    }

    fn with_memory_cache<T>(&self, op: impl FnOnce(&HashMap<String, ModelPricing>) -> T) -> T {
        let cache = lock_or_recover("pricing memory cache", &self.memory_cache);
        op(&cache)
    }

    fn with_memory_cache_mut<T>(
        &self,
        op: impl FnOnce(&mut HashMap<String, ModelPricing>) -> T,
    ) -> T {
        let mut cache = lock_or_recover("pricing memory cache", &self.memory_cache);
        op(&mut cache)
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Map our (provider, model) pair to OpenRouter's model ID format.
/// For most providers: `"{provider}/{model}"`.
/// For openrouter: the model_id is already in OpenRouter format (e.g. `google/gemini-3.1-flash-lite-preview`).
/// For anthropic: OpenRouter uses a dot for minor versions (e.g. `claude-opus-4.6` not `claude-opus-4-6`).
/// Custom providers (e.g. `openrouter-anthropic`) whose chat config resolves a
/// pre-formatted OpenRouter id like `anthropic/claude-opus-4.6` are detected
/// by the `/` in the model column and pass through unchanged.
pub fn to_openrouter_id(provider: &str, model: &str) -> String {
    if provider == "openrouter" || model.contains('/') {
        model.to_owned()
    } else if provider == "anthropic" {
        format!("anthropic/{}", normalize_anthropic_model(model))
    } else {
        format!("{provider}/{model}")
    }
}

/// Recognize Anthropic-family rows for cache health and diagnostics. Native
/// Anthropic uses the literal provider key; OpenRouter-routed Anthropic
/// (regardless of custom provider name) carries an `anthropic/...` model id by
/// the time it reaches the ledger. Mirrored in `query.rs` as the SQL fragment
/// `(provider = 'anthropic' OR model LIKE 'anthropic/%')`.
pub fn is_anthropic_pricing(provider: &str, model: &str) -> bool {
    provider == "anthropic" || model.starts_with("anthropic/")
}

fn normalize_anthropic_model(model: &str) -> String {
    let mut chars: Vec<char> = model.chars().collect();
    for (offset, window) in chars.windows(3).enumerate().rev() {
        let [before, separator, after] = window else {
            continue;
        };
        if *separator == '-' && before.is_ascii_digit() && after.is_ascii_digit() {
            let Some(separator_index) = offset.checked_add(1) else {
                break;
            };
            if let Some(ch) = chars.get_mut(separator_index) {
                *ch = '.';
            }
            break;
        }
    }
    chars.into_iter().collect()
}

/// Parse a price value from OpenRouter JSON. Prices can be string or number.
/// Returns 0.0 if missing or unparseable.
fn parse_price(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::String(s)) => s.parse().unwrap_or(0.0),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    }
}

// Bring optional() into scope for rusqlite queries
use rusqlite::OptionalExtension;

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::Arc;

    fn test_engine() -> PricingEngine {
        let ledger = Arc::new(Ledger::open_in_memory().unwrap());
        PricingEngine::new(ledger)
    }

    fn anthropic_pricing() -> ModelPricing {
        ModelPricing {
            input_per_token: 0.000_015,
            output_per_token: 0.000_075,
            cache_read_per_token: 0.000_001_5,
            cache_write_per_token: 0.000_018_75,
        }
    }

    #[test]
    fn calculate_cost_with_known_pricing() {
        let engine = test_engine();
        engine
            .store_pricing("anthropic/claude-opus-4.6", &anthropic_pricing())
            .unwrap();
        let cost = engine
            .calculate_cost(CostRequest {
                provider: "anthropic",
                model: "claude-opus-4-6",
                input_tokens: 100,
                output_tokens: 50,
                cache_read_tokens: 80,
                cache_write_tokens: 20,
                cache_ttl: Some("5m"),
            })
            .unwrap();
        assert!(cost.is_some());
        let c = cost.unwrap();
        assert!((c.input - 0.0015).abs() < 1e-10);
        assert!((c.output - 0.00375).abs() < 1e-10);
        assert!((c.cache_read - 0.00012).abs() < 1e-10);
        assert!((c.cache_write - 0.000_375).abs() < 1e-10);
    }

    #[test]
    fn calculate_cost_with_1h_cache_ttl() {
        let engine = test_engine();
        engine
            .store_pricing("anthropic/claude-opus-4.6", &anthropic_pricing())
            .unwrap();
        let cost = engine
            .calculate_cost(CostRequest {
                provider: "anthropic",
                model: "claude-opus-4-6",
                input_tokens: 100,
                output_tokens: 50,
                cache_read_tokens: 80,
                cache_write_tokens: 20,
                cache_ttl: Some("1h"),
            })
            .unwrap();
        assert!(cost.is_some());
        let c = cost.unwrap();
        assert!((c.input - 0.0015).abs() < 1e-10);
        assert!((c.output - 0.00375).abs() < 1e-10);
        assert!((c.cache_read - 0.00012).abs() < 1e-10);
        // 20 tokens * 0.000_018_75 * 1.6 = 0.0006
        assert!((c.cache_write - 0.0006).abs() < 1e-10);
        assert!((c.total - (0.0015 + 0.00375 + 0.00012 + 0.0006)).abs() < 1e-10);
    }

    #[test]
    fn calculate_cost_routed_anthropic_uses_catalog_cache_write_price() {
        let engine = test_engine();
        engine
            .store_pricing("anthropic/claude-opus-4.6", &anthropic_pricing())
            .unwrap();
        // Provider is the user's custom name; model is the resolved
        // OpenRouter id. OpenRouter bills its catalog cache-write price
        // directly, so the native Anthropic 1h multiplier must not apply.
        let cost = engine
            .calculate_cost(CostRequest {
                provider: "openrouter-anthropic",
                model: "anthropic/claude-opus-4.6",
                input_tokens: 100,
                output_tokens: 50,
                cache_read_tokens: 80,
                cache_write_tokens: 20,
                cache_ttl: Some("1h"),
            })
            .unwrap()
            .unwrap();
        assert!((cost.cache_write - 0.000_375).abs() < 1e-10);
    }

    #[test]
    fn calculate_cost_with_none_cache_ttl_defaults_to_1h() {
        let engine = test_engine();
        engine
            .store_pricing("anthropic/claude-opus-4.6", &anthropic_pricing())
            .unwrap();
        let cost = engine
            .calculate_cost(CostRequest {
                provider: "anthropic",
                model: "claude-opus-4-6",
                input_tokens: 100,
                output_tokens: 50,
                cache_read_tokens: 80,
                cache_write_tokens: 20,
                cache_ttl: None,
            })
            .unwrap();
        assert!(cost.is_some());
        let c = cost.unwrap();
        // Should use 1h price because default TTL is "1h"
        assert!((c.cache_write - 0.0006).abs() < 1e-10);
    }

    #[test]
    fn returns_none_for_unknown_model() {
        let engine = test_engine();
        let cost = engine
            .calculate_cost(CostRequest {
                provider: "unknown",
                model: "model",
                input_tokens: 100,
                output_tokens: 50,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                cache_ttl: None,
            })
            .unwrap();
        assert!(cost.is_none());
    }

    #[test]
    fn model_id_mapping() {
        assert_eq!(
            to_openrouter_id("anthropic", "claude-opus-4-6"),
            "anthropic/claude-opus-4.6"
        );
        assert_eq!(
            to_openrouter_id("anthropic", "claude-sonnet-4"),
            "anthropic/claude-sonnet-4"
        );
        assert_eq!(to_openrouter_id("openai", "gpt-4o"), "openai/gpt-4o");
        assert_eq!(
            to_openrouter_id("openrouter", "google/gemini-3.1-flash-lite-preview"),
            "google/gemini-3.1-flash-lite-preview"
        );
    }

    #[test]
    fn model_id_passthrough_for_prefixed_models() {
        // OpenRouter-routed Anthropic via custom provider name (e.g.
        // [providers.openrouter-anthropic] sdk = "anthropic"): the chat
        // config resolves model_id to `anthropic/<id>` before reaching the
        // ledger, so it must pass through unchanged.
        assert_eq!(
            to_openrouter_id("openrouter-anthropic", "anthropic/claude-opus-4.6"),
            "anthropic/claude-opus-4.6"
        );
        assert_eq!(
            to_openrouter_id("openrouter", "anthropic/claude-opus-4.6"),
            "anthropic/claude-opus-4.6"
        );
    }

    #[test]
    fn is_anthropic_pricing_recognizes_routed_calls() {
        assert!(is_anthropic_pricing("anthropic", "claude-opus-4-6"));
        assert!(is_anthropic_pricing(
            "openrouter-anthropic",
            "anthropic/claude-opus-4.6"
        ));
        assert!(is_anthropic_pricing(
            "openrouter",
            "anthropic/claude-opus-4.6"
        ));
        assert!(!is_anthropic_pricing("openai", "gpt-4o"));
        assert!(!is_anthropic_pricing("openrouter", "openai/gpt-4o"));
    }

    #[test]
    fn store_and_retrieve_pricing() {
        let engine = test_engine();
        engine
            .store_pricing("anthropic/claude-opus-4.6", &anthropic_pricing())
            .unwrap();
        let pricing = engine
            .get_cached_pricing("anthropic/claude-opus-4.6")
            .unwrap();
        assert!(pricing.is_some());
        let p = pricing.unwrap();
        assert!((p.input_per_token - 0.000_015).abs() < 1e-10);
        assert!((p.cache_write_per_token - 0.000_018_75).abs() < 1e-10);
    }

    #[test]
    fn clear_cache_removes_all() {
        let engine = test_engine();
        engine
            .store_pricing(
                "test/model",
                &ModelPricing {
                    input_per_token: 0.001,
                    output_per_token: 0.002,
                    cache_read_per_token: 0.0,
                    cache_write_per_token: 0.0,
                },
            )
            .unwrap();
        engine.clear_cache().unwrap();
        let pricing = engine.get_cached_pricing("test/model").unwrap();
        assert!(pricing.is_none());
    }

    #[test]
    fn parse_price_handles_string_and_number() {
        let s = Value::String("0.000015".into());
        assert!((parse_price(Some(&s)) - 0.000_015).abs() < 1e-10);

        let n = serde_json::json!(0.000_075);
        assert!((parse_price(Some(&n)) - 0.000_075).abs() < 1e-10);

        assert!((parse_price(None)).abs() < 1e-10);

        let null = Value::Null;
        assert!((parse_price(Some(&null))).abs() < 1e-10);
    }

    #[test]
    fn db_fallback_populates_memory_cache() {
        let engine = test_engine();
        let pricing = ModelPricing {
            input_per_token: 0.000_015,
            output_per_token: 0.000_075,
            cache_read_per_token: 0.000_001_5,
            cache_write_per_token: 0.000_018_75,
        };
        engine.store_pricing("test/model", &pricing).unwrap();

        // Clear memory cache only, leaving DB intact
        engine.memory_cache.lock().unwrap().clear();

        // Should read from DB and re-populate memory
        let result = engine.get_cached_pricing("test/model").unwrap();
        assert!(result.is_some());
        assert!((result.unwrap().input_per_token - 0.000_015).abs() < 1e-10);

        // Verify memory cache was repopulated
        let cache = engine.memory_cache.lock().unwrap();
        assert!(cache.contains_key("test/model"));
    }

    #[test]
    fn poisoned_memory_cache_mutex_is_recovered() {
        let engine = test_engine();

        let result = catch_unwind(AssertUnwindSafe(|| {
            let _guard = engine.memory_cache.lock().unwrap();
            panic!("poison pricing memory cache");
        }));
        assert!(result.is_err());

        engine
            .store_pricing(
                "test/model",
                &ModelPricing {
                    input_per_token: 0.001,
                    output_per_token: 0.002,
                    cache_read_per_token: 0.0,
                    cache_write_per_token: 0.0,
                },
            )
            .unwrap();

        let cached = engine.get_cached_pricing("test/model").unwrap();
        assert!(cached.is_some());
    }
}
