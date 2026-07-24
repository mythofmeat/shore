//! Background auto-discovery loop for provider model catalogs.
//!
//! On boot and on a 24h cadence (`crate::llm::discovery::REFRESH_INTERVAL`),
//! every provider that is `enabled` AND has `discovery.enabled = true` is
//! refreshed if its on-disk cache is missing or older than the TTL.
//!
//! Per-provider failures are `tracing::warn!`-logged and never propagate —
//! a transient outage at one provider must not block the rest of the
//! daemon from starting. The atomic write semantics in
//! `discovery::write_cache` already preserve the previous cache on
//! serialization or I/O failure.

use std::path::PathBuf;
use std::time::Duration;

use crate::ledger::LedgerClient;
use crate::llm::discovery;
use shore_common::config::LoadedConfig;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use crate::commands::providers::refresh_one;

/// Spawn the auto-discovery loop. The first pass runs immediately; later
/// passes fire every `interval`.
///
/// `interval` is parameterized so tests can drive the loop with a tiny
/// duration; production callers pass [`discovery::REFRESH_INTERVAL`].
pub fn spawn(
    config: LoadedConfig,
    cache_dir: PathBuf,
    llm_client: LedgerClient,
    interval: Duration,
    shutdown_rx: watch::Receiver<()>,
) -> JoinHandle<()> {
    tokio::spawn(run_loop(
        config,
        cache_dir,
        llm_client,
        interval,
        shutdown_rx,
    ))
}

async fn run_loop(
    config: LoadedConfig,
    cache_dir: PathBuf,
    llm_client: LedgerClient,
    interval: Duration,
    mut shutdown_rx: watch::Receiver<()>,
) {
    info!(
        interval_secs = interval.as_secs(),
        "Auto-discovery loop started"
    );

    let mut ticker = tokio::time::interval(interval);
    // `interval()` fires immediately on first poll — that's the boot pass.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => break,
            _ = ticker.tick() => {
                refresh_pass(&config, &cache_dir, &llm_client).await;
            }
        }
    }

    info!("Auto-discovery loop stopped");
}

async fn refresh_pass(config: &LoadedConfig, cache_dir: &std::path::Path, llm: &LedgerClient) {
    for (name, entry) in config.providers.iter() {
        if !entry.enabled || !entry.discovery.enabled {
            continue;
        }

        let cache_path = discovery::cache_path(cache_dir, name);
        let cache = discovery::read_cache(&cache_path).ok().flatten();
        let needs_refresh = cache.as_ref().is_none_or(discovery::is_stale);
        if !needs_refresh {
            debug!(provider = %name, "Cache fresh; skipping auto-refresh");
            continue;
        }

        match refresh_one(config, cache_dir, llm, name).await {
            Ok(outcome) => info!(
                provider = %name,
                models = outcome.cache.models.len(),
                "Auto-refreshed provider models"
            ),
            Err((_code, message)) => warn!(
                provider = %name,
                error = %message,
                "Auto-refresh failed; previous cache preserved"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    use shore_common::config::providers::ProviderRegistry;

    fn loaded_with(toml_str: &str, data_dir: &Path) -> LoadedConfig {
        let providers = if toml_str.is_empty() {
            ProviderRegistry::default()
        } else {
            let table: toml::Table = toml_str.parse().unwrap();
            let section = table.get("providers").and_then(|v| v.as_table());
            ProviderRegistry::from_section(section).unwrap()
        };
        let mut loaded = LoadedConfig::new_for_test(
            shore_common::config::app::AppConfig::default(),
            shore_common::config::models::ModelCatalog::default(),
            shore_common::config::ShoreDirs {
                config: data_dir.join("config"),
                data: data_dir.to_path_buf(),
                runtime: data_dir.join("runtime"),
                cache: data_dir.join("cache"),
            },
        );
        loaded.providers = providers;
        loaded
    }

    #[tokio::test]
    async fn run_loop_exits_on_shutdown() {
        let tmp = tempfile::tempdir().unwrap();
        let config = loaded_with("", tmp.path());
        let llm = LedgerClient::new(
            crate::llm::LlmClient::try_new().unwrap(),
            &tmp.path().join("ledger.db"),
        )
        .unwrap();

        let (tx, rx) = watch::channel(());
        let handle = spawn(
            config,
            tmp.path().to_path_buf(),
            llm,
            Duration::from_millis(50),
            rx,
        );
        // Let the boot pass run, then signal shutdown.
        tokio::time::sleep(Duration::from_millis(20)).await;
        let _ignored = tx.send(());
        let res = tokio::time::timeout(Duration::from_secs(1), handle).await;
        assert!(res.is_ok(), "loop should exit promptly on shutdown");
    }

    #[tokio::test]
    async fn refresh_pass_skips_disabled_and_discovery_disabled_without_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let config = loaded_with(
            r#"
[providers.alpha]
enabled = false

[providers.beta]
api_key_env = "BETA_KEY"

[providers.beta.discovery]
enabled = false
"#,
            tmp.path(),
        );
        let llm = LedgerClient::new(
            crate::llm::LlmClient::try_new().unwrap(),
            &tmp.path().join("ledger.db"),
        )
        .unwrap();

        // Should be a no-op for both providers; absence of panic is the assertion.
        refresh_pass(&config, tmp.path(), &llm).await;
    }

    #[tokio::test]
    async fn refresh_pass_skips_recent_cache() {
        // A fresh cache must not trigger an HTTP fetch. We don't run a
        // mock server — if a fetch is attempted, the missing key path
        // will error inside refresh_one, which still wouldn't fail the
        // test (warn only). Instead, we observe that the cache file is
        // not modified.
        let tmp = tempfile::tempdir().unwrap();
        let key = format!("AUTO_DISCOVERY_FRESH_{}", std::process::id());
        std::env::set_var(&key, "sk-fixture");
        let config = loaded_with(
            &format!(
                r#"
[providers.upstream]
base_url = "https://example.test/v1"

[[providers.upstream.keys]]
name = "main"
env = "{key}"

[providers.upstream.discovery]
enabled = true
"#
            ),
            tmp.path(),
        );
        let llm = LedgerClient::new(
            crate::llm::LlmClient::try_new().unwrap(),
            &tmp.path().join("ledger.db"),
        )
        .unwrap();

        // Pre-write a fresh cache.
        let cache_path = discovery::cache_path(tmp.path(), "upstream");
        let fresh = discovery::ProviderModelsCache {
            version: discovery::CACHE_VERSION,
            provider_key: "upstream".into(),
            fetched_at: chrono::Utc::now().to_rfc3339(),
            base_url: Some("https://example.test/v1".into()),
            models: vec![],
        };
        discovery::write_cache(&cache_path, &fresh).unwrap();
        let mtime_before = std::fs::metadata(&cache_path).unwrap().modified().unwrap();

        // Allow the filesystem clock to advance so a same-millisecond
        // overwrite would be observable.
        tokio::time::sleep(Duration::from_millis(20)).await;

        refresh_pass(&config, tmp.path(), &llm).await;

        let mtime_after = std::fs::metadata(&cache_path).unwrap().modified().unwrap();
        assert_eq!(mtime_before, mtime_after, "fresh cache must not be touched");

        std::env::remove_var(&key);
    }
}
