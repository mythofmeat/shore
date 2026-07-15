use serde_json::json;
use shore_protocol::error::ErrorCode;
use tracing::info;

use crate::commands::{CommandContext, CommandResult};

/// Report the effective tool surface: every registered tool, whether it is
/// enabled on the main character, which enabled sub-agents own it, the
/// sub-agent roster, the exec allowlist, and any dangling config references.
/// Read-only — backs `shore tools`.
pub fn tools(ctx: &CommandContext) -> CommandResult {
    let cfg = &ctx.config.app.tools;
    let subagents = &ctx.config.app.subagents;
    let registry = crate::tools::all_tools();
    let known: Vec<&str> = registry.iter().map(|t| t.name).collect();

    // Per-tool rows: main-character enablement + which enabled sub-agents own it.
    let tool_rows: Vec<_> = registry
        .iter()
        .map(|def| {
            let owners: Vec<String> = cfg
                .enabled_subagents
                .iter()
                .filter(|s| {
                    subagents
                        .get(*s)
                        .is_some_and(|sa| sa.tools.iter().any(|t| t == def.name))
                })
                .cloned()
                .collect();
            json!({
                "tool": def.name,
                "main": cfg.tool_enabled(def.name),
                "subagents": owners,
            })
        })
        .collect();

    // Sub-agent roster.
    let subagent_rows: Vec<_> = subagents
        .iter()
        .map(|(name, sa)| {
            json!({
                "name": name,
                "enabled": cfg.subagent_enabled(name),
                "tools": sa.tools,
                "model": sa.model,
            })
        })
        .collect();

    // Dangling references — surfaced so a typo or stale name is visible.
    let mut warnings: Vec<String> = Vec::new();
    for t in &cfg.enabled_tools {
        if !known.contains(&t.as_str()) {
            warnings.push(format!("enabled_tools references unknown tool '{t}'"));
        }
    }
    for s in &cfg.enabled_subagents {
        if !subagents.contains_key(s) {
            warnings.push(format!(
                "enabled_subagents references undefined subagent '{s}'"
            ));
        }
    }
    for (name, sa) in subagents {
        for t in &sa.tools {
            if !known.contains(&t.as_str()) {
                warnings.push(format!("subagent '{name}' references unknown tool '{t}'"));
            }
        }
    }

    Ok(json!({
        "tools": tool_rows,
        "subagents": subagent_rows,
        "exec_allowlist": crate::tools::workspace::exec_allowlist(),
        "warnings": warnings,
    }))
}

/// Validate configuration and return warnings/info.
pub async fn config_check(ctx: &CommandContext) -> CommandResult {
    let mut warnings: Vec<String> = Vec::new();
    let mut info: Vec<String> = Vec::new();

    // Check: any chat models configured?
    if ctx.config.models.chat.is_empty() {
        warnings.push(
            "No chat models configured. Add a [providers.*] entry and set \
             [defaults].model to a provider:model_id."
                .into(),
        );
    } else {
        info.push(format!(
            "{} chat model(s) configured",
            ctx.config.models.chat.len()
        ));
    }

    // Check: default model set?
    match &ctx.config.app.defaults.model {
        Some(m) => {
            if ctx.config.models.find_model(m).is_ok() {
                info.push(format!("Default model: {m}"));
            } else {
                warnings.push(format!("Default model \"{m}\" not found in catalog"));
            }
        }
        None => {
            if !ctx.config.models.chat.is_empty() {
                warnings.push("No default model set. First chat model will be used.".into());
            }
        }
    }

    // Check: API key env vars are set for configured providers
    for model in ctx.config.models.chat.values() {
        if let Some(ref key_env) = model.api_key_env {
            if std::env::var(key_env).is_err() {
                warnings.push(format!(
                    "API key env var ${} not set (needed by model {})",
                    key_env, model.qualified_name
                ));
            }
        }
    }

    let valid = warnings.is_empty();

    Ok(json!({
        "valid": valid,
        "warnings": warnings,
        "info": info,
        "config_dir": ctx.config.dirs.config.display().to_string(),
        "data_dir": ctx.config.dirs.data.display().to_string(),
        "cache_dir": ctx.config.dirs.cache.display().to_string(),
        "chat_models": ctx.config.models.chat.len(),
        "memory_mode": "markdown",
    }))
}

pub fn config(ctx: &mut CommandContext, args: &serde_json::Value) -> CommandResult {
    let key_arg = args.get("key").and_then(|v| v.as_str());
    let value_arg = args.get("value").and_then(|v| v.as_str());

    // If both key and value are present, this is a config set operation.
    if let (Some(key), Some(value)) = (key_arg, value_arg) {
        return config_set(ctx, key, value);
    }

    // Otherwise, read-only config display.
    let app_json = serde_json::to_value(&ctx.config.app).map_err(|e| {
        (
            ErrorCode::InternalError,
            format!("Failed to serialize config: {e}"),
        )
    })?;
    // Ship the built-in defaults as a baseline so the CLI can distinguish
    // user-customized values from defaults.
    let defaults_json =
        serde_json::to_value(shore_config::app::AppConfig::default()).map_err(|e| {
            (
                ErrorCode::InternalError,
                format!("Failed to serialize default config: {e}"),
            )
        })?;

    match key_arg {
        None => Ok(json!({ "config": app_json, "defaults": defaults_json })),
        Some(name) => match app_json.get(name) {
            Some(data) => {
                let default_section = defaults_json.get(name).cloned();
                Ok(json!({
                    "key": name,
                    "config": data,
                    "defaults": default_section,
                }))
            }
            None => Err((
                ErrorCode::NotFound,
                format!("Config section not found: {name}"),
            )),
        },
    }
}

/// Set a runtime config value. Only a focused set of keys are supported.
fn config_set(ctx: &mut CommandContext, key: &str, value: &str) -> CommandResult {
    match key {
        "defaults.model" | "model" => {
            // Validate the model exists.
            let _ignored = ctx
                .config
                .models
                .find_model(value)
                .map_err(|e| (ErrorCode::NotFound, format!("{e}")))?;
            ctx.active_model = Some(value.to_owned());
            // Override no longer matches whatever was pre-resolved from
            // preferences — drop the cached ResolvedModel so the next
            // command re-resolves against the new name.
            ctx.active_resolved_model = None;
            Ok(json!({ "set": key, "value": value }))
        }
        "defaults.stream" | "stream" => {
            let v: bool = value
                .parse()
                .map_err(|_| (ErrorCode::InvalidRequest, "expected true or false".into()))?;
            ctx.config.app.defaults.stream = v;
            Ok(json!({ "set": key, "value": v }))
        }
        "autonomy.enabled" | "behavior.autonomy.enabled" => {
            let v: bool = value
                .parse()
                .map_err(|_| (ErrorCode::InvalidRequest, "expected true or false".into()))?;
            ctx.config.app.behavior.autonomy.enabled = v;
            Ok(json!({ "set": "autonomy.enabled", "value": v }))
        }
        _ => Err((
            ErrorCode::InvalidRequest,
            format!(
                "Config key not settable at runtime: {key}. Supported: defaults.model, defaults.stream, autonomy.enabled"
            ),
        )),
    }
}

/// Manually reload configuration from disk, optionally activating pending
/// system-prompt (workspace) edits for the current character.
///
/// Two-phase protocol driven by the client:
/// - `{}` (check): validate the on-disk config (global + per-character
///   overlays) and report which prompt-visible files differ from the active
///   snapshot. No state changes.
/// - `{ "apply": true, "refresh_prompts": bool }`: re-validate, then refresh
///   the active prompt snapshot if requested, then adopt the fresh config.
///   Unlike `config_reset`, runtime overrides (active model) are preserved.
///
/// Any validation failure aborts before any state changes.
pub fn config_reload(ctx: &mut CommandContext, args: &serde_json::Value) -> CommandResult {
    let apply = args
        .get("apply")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let refresh_prompts = args
        .get("refresh_prompts")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let config_path = ctx.config_path.clone();
    let fresh = shore_config::load_config(Some(&config_path))
        .map_err(|e| (ErrorCode::InvalidRequest, format!("Config error: {e}")))?;

    // Validate per-character overlays against the fresh global config so a
    // broken characters/<name>/config.toml aborts the reload instead of
    // silently falling back to the global config at merge time.
    for name in shore_config::discover_characters(&fresh.dirs.config) {
        if let Err(e) = shore_config::load_character_config(&fresh, &name) {
            return Err((
                ErrorCode::InvalidRequest,
                format!("Config error in character overlay '{name}': {e}"),
            ));
        }
    }

    let char_name = ctx.character_name.clone().ok_or((
        ErrorCode::InvalidRequest,
        "config_reload requires a character context".to_owned(),
    ))?;
    let character_data_dir = ctx.config.dirs.data.join(&char_name);
    let changed_prompt_files = crate::memory::deferred_edits::changed_prompt_files(
        &character_data_dir,
        &fresh.dirs.config,
        &char_name,
    );

    // `restart_required` is annotated by the dispatcher's post-processing,
    // which compares global-to-global; this context only holds the
    // character-merged config, which would produce false positives.
    if !apply {
        return Ok(json!({
            "applied": false,
            "config_path": config_path.display().to_string(),
            "character": char_name,
            "changed_prompt_files": changed_prompt_files,
        }));
    }

    // Refresh prompts before adopting the config so an IO failure leaves the
    // daemon fully on the previous state.
    let mut prompts_refreshed = false;
    if refresh_prompts {
        crate::memory::deferred_edits::apply_deferred_edits(
            &character_data_dir,
            &fresh.dirs.config,
            &char_name,
        )
        .map_err(|e| {
            (
                ErrorCode::InternalError,
                format!("Failed to refresh active prompt snapshot: {e}"),
            )
        })?;
        // The cached heartbeat/keepalive request still carries the old prompt
        // bytes; drop it so background calls rebuild from the new snapshot.
        ctx.autonomy.notify_prompt_snapshot_refreshed(&char_name);
        prompts_refreshed = true;
        info!(
            character = %char_name,
            files = ?changed_prompt_files,
            "Active prompt snapshot refreshed via config_reload"
        );
    }

    ctx.autonomy.reload_runtime_config(fresh.clone());
    ctx.llm_client.set_usage_config(fresh.app.usage.clone());
    ctx.llm_client.set_cache_keepalive_ceiling(
        fresh
            .app
            .behavior
            .autonomy
            .cache_keepalive_max
            .as_duration(),
    );
    ctx.config = fresh;
    info!(path = %config_path.display(), "Configuration reloaded from disk (manual)");

    Ok(json!({
        "applied": true,
        "config_path": config_path.display().to_string(),
        "character": char_name,
        "changed_prompt_files": changed_prompt_files,
        "prompts_refreshed": prompts_refreshed,
    }))
}

/// Reset all runtime config overrides by reloading from disk.
pub fn config_reset(ctx: &mut CommandContext) -> CommandResult {
    let config_path = ctx.config_path.clone();
    match shore_config::load_config(Some(&config_path)) {
        Ok(fresh) => {
            ctx.active_model = None;
            ctx.active_resolved_model = None;
            ctx.autonomy.reload_runtime_config(fresh.clone());
            ctx.llm_client.set_usage_config(fresh.app.usage.clone());
            ctx.llm_client.set_cache_keepalive_ceiling(
                fresh
                    .app
                    .behavior
                    .autonomy
                    .cache_keepalive_max
                    .as_duration(),
            );
            ctx.config = fresh;
            info!(path = %config_path.display(), "Configuration reloaded from disk");
            Ok(json!({
                "reset": true,
                "message": "Configuration reloaded from disk",
                "config_path": config_path.display().to_string(),
                "invalidated": {
                    "runtime_overrides": true,
                }
            }))
        }
        Err(e) => Err((
            ErrorCode::InternalError,
            format!("Failed to reload config: {e}"),
        )),
    }
}
