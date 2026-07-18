use serde_json::{json, Value};
use shore_protocol::error::ErrorCode;
use tracing::info;

use crate::commands::{CommandContext, CommandResult};
use crate::effective_catalog::{self, EffectiveCatalogError, EffectiveModel, EffectiveSource};
use crate::preferences::{self, ModelPreferences, PreferenceScope, SamplerSettings};

// ── Helpers ─────────────────────────────────────────────────────────────

/// Names of every sampler key `set_model_setting` accepts.
const SAMPLER_KEYS: &[&str] = &[
    "temperature",
    "top_p",
    "reasoning_effort",
    "budget_tokens",
    "max_output_tokens",
    "cache_ttl",
    // Daemon-side keepalive ping cadence ("off" or a duration like "55m").
    // Not a wire field, but honored for every sdk with a prompt cache; the
    // capability matrix (`Field::CacheKeepalive`) gates the value domain.
    "cache_keepalive",
    "sdk",
    // Thinking-history replay (#191). Capability-gated: honored where an
    // adapter puts surviving thinking on the wire, a soft error where it
    // cannot change anything (gemini; native deepseek/moonshot, whose
    // provider floor forces full replay) — see `Field::ReplayPriorThinking`.
    "replay_prior_thinking",
    // Unified per-model tool-iteration cap (None/unset = unlimited). Honored by
    // every sdk and every tool loop (chat, heartbeat, compaction, dreaming), so
    // it is not capability-gated.
    "max_tool_iterations",
    // Vendor knobs (per-model). The capability matrix gates which of these a
    // given model's resolved sdk actually honors — see `capability_check`.
    "openrouter_provider",
    "vertex_project",
    "vertex_location",
    "gemini_generation",
    "gemini_web_search",
    "zai_clear_thinking",
    "zai_subscription",
];

/// Resolve the character whose preferences should be loaded/saved.
fn require_character(ctx: &CommandContext) -> Result<&str, (ErrorCode, String)> {
    ctx.character_name.as_deref().ok_or((
        ErrorCode::InvalidRequest,
        "this command requires an attached character".into(),
    ))
}

/// Resolve the active model for the current session.
///
/// Prefers `ctx.active_resolved_model` (the dispatcher's pre-resolved
/// selection from preferences) so we never round-trip a discovered
/// model's synthetic `qualified_name` back through
/// `find_effective_model` — that round-trip fails NotFound and is
/// pinned by [`effective_catalog::tests::synthetic_discovered_qualified_name_is_not_a_resolver_input`].
/// Falls back to resolving `ctx.active_model` (or `app.defaults.model`)
/// by name when no pre-resolved model is set. `include_hidden = true`
/// because the user has already explicitly chosen the active selection.
fn resolve_active_model(
    ctx: &CommandContext,
) -> Result<shore_config::models::ResolvedModel, (ErrorCode, String)> {
    if let Some(resolved) = ctx.active_resolved_model.as_ref() {
        return Ok(resolved.clone());
    }
    let name = ctx
        .active_model
        .as_deref()
        .or(ctx.config.app.defaults.model.as_deref())
        .ok_or((
            ErrorCode::InvalidRequest,
            "No model specified and no active model set".into(),
        ))?;
    effective_catalog::find_effective_model(&ctx.config, &ctx.config.dirs.cache, name, true)
        .map_err(|e| effective_catalog_err(&e))
}

fn effective_catalog_err(e: &EffectiveCatalogError) -> (ErrorCode, String) {
    match e {
        EffectiveCatalogError::NotFound { .. } | EffectiveCatalogError::Hidden { .. } => {
            (ErrorCode::NotFound, e.to_string())
        }
        EffectiveCatalogError::Ambiguous { .. } => (ErrorCode::InvalidRequest, e.to_string()),
    }
}

/// Parse a background-task selector string into the config enum.
fn background_task_from_str(s: &str) -> Option<shore_config::app::BackgroundTask> {
    use shore_config::app::BackgroundTask;
    match s {
        "heartbeat" => Some(BackgroundTask::Heartbeat),
        "compaction" => Some(BackgroundTask::Compaction),
        "dreaming" => Some(BackgroundTask::Dreaming),
        _ => None,
    }
}

fn background_task_label(task: shore_config::app::BackgroundTask) -> &'static str {
    use shore_config::app::BackgroundTask;
    match task {
        BackgroundTask::Heartbeat => "heartbeat",
        BackgroundTask::Compaction => "compaction",
        BackgroundTask::Dreaming => "dreaming",
    }
}

/// Resolve the *base* model identity backing a background task, mirroring the
/// model-selection half of [`preferences::resolve_background_model`] (config
/// pin → active chat model) without applying the sampler overlay. Used to key
/// settings reads/writes onto the right `provider:model_id`, so the user can
/// tune a background model without first switching chat to it.
fn resolve_background_target_model(
    ctx: &CommandContext,
    task: shore_config::app::BackgroundTask,
) -> Result<shore_config::models::ResolvedModel, (ErrorCode, String)> {
    if let Some(name) = ctx.config.app.defaults.resolve_background_model_name(task) {
        return effective_catalog::find_effective_model(
            &ctx.config,
            &ctx.config.dirs.cache,
            name,
            true,
        )
        .map_err(|e| effective_catalog_err(&e));
    }
    // No background pin: the task inherits the character's active chat model.
    let character = require_character(ctx)?;
    preferences::resolve_chat_model_for_character(&ctx.config, character).ok_or((
        ErrorCode::NotFound,
        format!(
            "{} has no configured model and the catalog has no chat model to inherit",
            background_task_label(task)
        ),
    ))
}

/// Resolve the model a settings command targets when a `background_task`
/// selector is present. `"all"` requires every background task to collapse to a
/// single model identity; otherwise it errors with the per-task mapping so the
/// user knows which task to target individually.
fn resolve_background_setting_target(
    ctx: &CommandContext,
    selector: &str,
) -> Result<shore_config::models::ResolvedModel, (ErrorCode, String)> {
    use shore_config::app::BackgroundTask;
    if selector != "all" {
        let task = background_task_from_str(selector).ok_or((
            ErrorCode::InvalidRequest,
            format!(
                "unknown background task: {selector}; expected all, heartbeat, compaction, or dreaming"
            ),
        ))?;
        return resolve_background_target_model(ctx, task);
    }

    // Resolve all three; `all` only works when they collapse to one model. A
    // fixed-size array lets the compiler prove the destructure below is total,
    // so there's no dead fallback branch and no panicking index.
    let resolved = [
        (
            BackgroundTask::Heartbeat,
            resolve_background_target_model(ctx, BackgroundTask::Heartbeat)?,
        ),
        (
            BackgroundTask::Compaction,
            resolve_background_target_model(ctx, BackgroundTask::Compaction)?,
        ),
        (
            BackgroundTask::Dreaming,
            resolve_background_target_model(ctx, BackgroundTask::Dreaming)?,
        ),
    ];
    let [(_, first), ..] = &resolved;
    let all_same = resolved
        .iter()
        .all(|(_, m)| m.provider_key == first.provider_key && m.model_id == first.model_id);
    if all_same {
        return Ok(first.clone());
    }
    let mapping = resolved
        .iter()
        .map(|(task, m)| format!("{} → {}", background_task_label(*task), m.qualified_name))
        .collect::<Vec<_>>()
        .join(", ");
    Err((
        ErrorCode::InvalidRequest,
        format!(
            "background tasks use different models ({mapping}); target a specific task instead of `all`"
        ),
    ))
}

/// Resolve the model a settings read/write should operate on: an explicit
/// `background_task` selector wins, then an explicit `name`, then the active
/// chat model.
fn resolve_setting_target(
    ctx: &CommandContext,
    args: &Value,
) -> Result<shore_config::models::ResolvedModel, (ErrorCode, String)> {
    if let Some(selector) = args.get("background_task").and_then(|v| v.as_str()) {
        return resolve_background_setting_target(ctx, selector);
    }
    if let Some(name) = args
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        return effective_catalog::find_effective_model(
            &ctx.config,
            &ctx.config.dirs.cache,
            name,
            true,
        )
        .map_err(|e| effective_catalog_err(&e));
    }
    resolve_active_model(ctx)
}

/// Report which model each background task resolves to, plus where that
/// selection comes from (per-task pin, blanket pin, or inherited chat model).
/// Read-only companion to the `[defaults.background]` config section.
pub fn background_models(ctx: &CommandContext) -> CommandResult {
    use shore_config::app::BackgroundTask;
    let bg = &ctx.config.app.defaults.background;
    let tasks = [
        BackgroundTask::Heartbeat,
        BackgroundTask::Compaction,
        BackgroundTask::Dreaming,
    ];
    let mut rows = Vec::with_capacity(tasks.len());
    for task in tasks {
        let label = background_task_label(task);
        let per_task = match task {
            BackgroundTask::Heartbeat => bg.heartbeat.as_deref(),
            BackgroundTask::Compaction => bg.compaction.as_deref(),
            BackgroundTask::Dreaming => bg.dreaming.as_deref(),
        };
        let (model, source) = if let Some(name) = per_task.or(bg.model.as_deref()) {
            let qualified = effective_catalog::find_effective_model(
                &ctx.config,
                &ctx.config.dirs.cache,
                name,
                true,
            )
            .map_or_else(|_| name.to_owned(), |m| m.qualified_name);
            let source = if per_task.is_some() {
                format!("config: background.{label}")
            } else {
                "config: background.model".to_owned()
            };
            (qualified, source)
        } else {
            // Inherits the character's active chat model.
            let qualified = ctx
                .character_name
                .as_deref()
                .and_then(|c| preferences::resolve_chat_model_for_character(&ctx.config, c))
                .map_or_else(|| "(unresolved)".to_owned(), |m| m.qualified_name);
            (qualified, "inherited: active chat model".to_owned())
        };
        rows.push(json!({ "task": label, "model": model, "source": source }));
    }
    Ok(json!({ "background": rows }))
}

fn save_char_prefs(
    ctx: &CommandContext,
    char_name: &str,
    prefs: &ModelPreferences,
) -> Result<(), (ErrorCode, String)> {
    preferences::save_character_preferences(&ctx.data_dir, char_name, prefs).map_err(|e| {
        (
            ErrorCode::InternalError,
            format!("Failed to save preferences: {e}"),
        )
    })
}

fn load_char_prefs(
    ctx: &CommandContext,
    char_name: &str,
) -> Result<ModelPreferences, (ErrorCode, String)> {
    preferences::load_preferences(&preferences::character_preferences_path(
        &ctx.data_dir,
        char_name,
    ))
    .map_err(|e| {
        (
            ErrorCode::InternalError,
            format!("Failed to load preferences: {e}"),
        )
    })
}

/// Map each settable sampler key to how the resolved `sdk` treats it (#162):
/// `"honored"` / `"ignored"` / `"rejected"` from the capability matrix, or
/// `"always"` for Shore-only keys (`sdk`, `max_tool_iterations`) that name no
/// matrix field. Clients show only `honored` / `always` keys.
fn key_applicability(sdk: &shore_config::models::Sdk, model_id: &str) -> Value {
    use shore_config::capabilities::{applicability, Applicability, Field};
    let mut map = serde_json::Map::new();
    for key in SAMPLER_KEYS {
        let label = match Field::from_key(key) {
            None => "always",
            Some(field) => match applicability(sdk, model_id, field) {
                Applicability::Honored => "honored",
                Applicability::Ignored => "ignored",
                Applicability::Rejected => "rejected",
            },
        };
        let _ignored = map.insert((*key).to_owned(), json!(label));
    }
    Value::Object(map)
}

fn scope_str(scope: PreferenceScope) -> &'static str {
    match scope {
        PreferenceScope::StaticDefault => "static_default",
        PreferenceScope::GlobalDefault => "global_default",
        PreferenceScope::CharacterDefault => "character_default",
        PreferenceScope::GlobalModel => "global_model",
        PreferenceScope::CharacterModel => "character_model",
    }
}

// ── Commands ────────────────────────────────────────────────────────────

/// List available chat model profiles. Tool-only profiles, embedding
/// profiles, and image-generation profiles are intentionally excluded:
/// they are not user-selectable chat targets.
///
/// Phase 7+: also includes models discovered through provider registries
/// (`[providers.<name>]` + cached `/v1/models` results). Each entry
/// carries `source = "static" | "discovered"` so clients can render them
/// distinctly. Hidden discovered models are dropped unless
/// `include_hidden = true` is passed.
pub fn list_models(ctx: &CommandContext) -> CommandResult {
    list_models_with_args(ctx, &Value::Null)
}

pub fn list_models_with_args(ctx: &CommandContext, args: &Value) -> CommandResult {
    let include_hidden = args
        .get("include_hidden")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let entries = effective_catalog::list_effective_models(
        &ctx.config,
        &ctx.config.dirs.cache,
        include_hidden,
    );
    let models: Vec<Value> = entries.iter().map(effective_model_to_json).collect();
    let active = list_models_active_name(ctx, &entries);

    let hidden_count = if include_hidden {
        entries.iter().filter(|e| e.hidden).count()
    } else {
        // Recompute the hidden count when not folded in.
        let with_hidden =
            effective_catalog::list_effective_models(&ctx.config, &ctx.config.dirs.cache, true);
        with_hidden.iter().filter(|e| e.hidden).count()
    };

    Ok(json!({
        "models": models,
        "active": active,
        "include_hidden": include_hidden,
        "hidden_count": hidden_count,
    }))
}

fn list_models_active_name(ctx: &CommandContext, entries: &[EffectiveModel]) -> Option<String> {
    // Prefer the already-resolved active model: it carries the canonical
    // `qualified_name` directly, so there's no need to re-resolve the
    // `active_model` string. Crucially, a discovered model's `qualified_name`
    // (`chat.<provider>.<model_id>`) is a *display-only* synthetic name that is
    // not a valid resolver input — feeding it back through the resolver always
    // misses (and used to log a spurious catalog warning). Reading the resolved
    // model sidesteps that round-trip entirely.
    if let Some(resolved) = ctx.active_resolved_model.as_ref() {
        return Some(resolved.qualified_name.clone());
    }
    if let Some(active) = ctx.active_model.as_deref().filter(|s| !s.is_empty()) {
        return effective_catalog::find_effective_model(
            &ctx.config,
            &ctx.config.dirs.cache,
            active,
            true,
        )
        .map(|m| m.qualified_name)
        .or_else(|_| {
            ctx.config
                .models
                .find_model(active)
                .map(|m| m.qualified_name.clone())
        })
        .ok()
        .or_else(|| Some(active.to_owned()));
    }

    if let Some(default) = ctx
        .config
        .app
        .defaults
        .model
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        return effective_catalog::find_effective_model(
            &ctx.config,
            &ctx.config.dirs.cache,
            default,
            true,
        )
        .map(|m| m.qualified_name)
        .or_else(|_| {
            ctx.config
                .models
                .find_model(default)
                .map(|m| m.qualified_name.clone())
        })
        .ok()
        .or_else(|| Some(default.to_owned()));
    }

    entries.first().map(|e| e.resolved.qualified_name.clone())
}

fn effective_model_to_json(entry: &EffectiveModel) -> Value {
    let m = &entry.resolved;
    json!({
        "name": m.name,
        "qualified_name": m.qualified_name,
        "sdk": m.sdk.as_str(),
        "provider": m.provider_key,
        "model_id": m.model_id,
        "source": match entry.source {
            EffectiveSource::Static => "static",
            EffectiveSource::Discovered => "discovered",
        },
        "hidden": entry.hidden,
    })
}

/// Show detailed info for a model. If no name given, uses the active model.
///
/// Phase 3+: also returns `effective_sampler` + `scopes` so users can see
/// which preference layer last set each value.
pub fn model_info(ctx: &CommandContext, args: &Value) -> CommandResult {
    let name_arg = args
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    let resolved = match name_arg {
        Some(name) => {
            effective_catalog::find_effective_model(&ctx.config, &ctx.config.dirs.cache, name, true)
                .map_err(|e| effective_catalog_err(&e))?
        }
        None => resolve_active_model(ctx)?,
    };

    let mut data = serde_json::to_value(&resolved).map_err(|e| {
        (
            ErrorCode::InternalError,
            format!("Failed to serialize model: {e}"),
        )
    })?;

    // Augment with effective sampler + scope per field.
    if let Some(char_name) = ctx.character_name.as_deref() {
        let (global, char_prefs) = preferences::load_for_character(&ctx.data_dir, char_name)
            .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
        let sampler = preferences::resolve_sampler_settings(
            &global,
            Some(&char_prefs),
            &resolved.provider_key,
            &resolved.model_id,
            Some(&resolved),
        );
        let scopes = preferences::resolve_sampler_scopes(
            &global,
            Some(&char_prefs),
            &resolved.provider_key,
            &resolved.model_id,
            Some(&resolved),
        );
        if let Some(obj) = data.as_object_mut() {
            let _ignored = obj.insert(
                "effective_sampler".into(),
                serde_json::to_value(&sampler).unwrap_or(Value::Null),
            );
            _ = obj.insert(
                "scopes".into(),
                json!({
                    "temperature": scopes.temperature.map(scope_str),
                    "top_p": scopes.top_p.map(scope_str),
                    "reasoning_effort": scopes.reasoning_effort.map(scope_str),
                    "budget_tokens": scopes.budget_tokens.map(scope_str),
                    "max_output_tokens": scopes.max_output_tokens.map(scope_str),
                    "cache_ttl": scopes.cache_ttl.map(scope_str),
                    "cache_keepalive": scopes.cache_keepalive.map(scope_str),
                    "sdk": scopes.sdk.map(scope_str),
                    "replay_prior_thinking": scopes.replay_prior_thinking.map(scope_str),
                    "max_tool_iterations": scopes.max_tool_iterations.map(scope_str),
                }),
            );
        }
    }

    Ok(data)
}

/// Switch model or show current. Validates against the effective catalog
/// (static + discovered) and persists the selection to the character's
/// preferences file.
///
/// Phase 7+: hidden discovered models cannot be selected unless the
/// caller passes `include_hidden = true`. The error spells out how to
/// either opt in for the call or update `discovery.ignore` rules permanently.
pub fn switch_model(ctx: &mut CommandContext, args: &Value) -> CommandResult {
    let name_arg = args.get("name").and_then(|v| v.as_str());
    let include_hidden = args
        .get("include_hidden")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    match name_arg {
        None => Ok(json!({ "active": ctx.active_model })),
        Some(name) => {
            let resolved = effective_catalog::find_effective_model(
                &ctx.config,
                &ctx.config.dirs.cache,
                name,
                include_hidden,
            )
            .map_err(|e| effective_catalog_err(&e))?;

            let char_name = require_character(ctx)?.to_owned();
            let mut prefs = load_char_prefs(ctx, &char_name)?;
            prefs.selected.provider = Some(resolved.provider_key.clone());
            prefs.selected.model_id = Some(resolved.model_id.clone());
            save_char_prefs(ctx, &char_name, &prefs)?;

            // Keep ctx.active_model as the user-supplied name so existing
            // session/CLI flows that expect the raw name keep working.
            // Persistence uses (provider, model_id) so aliases survive.
            ctx.active_model = Some(name.to_owned());
            // Also park the resolved model so any subsequent command in
            // this same connection (e.g. `set_model_setting`) doesn't
            // need to re-resolve — and for discovered models, can't.
            ctx.active_resolved_model = Some(resolved.clone());
            info!(
                character = %char_name,
                model = %resolved.qualified_name,
                provider = %resolved.provider_key,
                model_id = %resolved.model_id,
                "Model switched (persisted to preferences)"
            );
            Ok(json!({
                "active": name,
                "qualified_name": resolved.qualified_name,
                "provider": resolved.provider_key,
                "model_id": resolved.model_id,
                "changed": true,
            }))
        }
    }
}

/// Reset model selection — clears the character's `[selected]` block so
/// the daemon falls back to global preferences / `app.defaults.model` /
/// the first chat model.
pub fn reset_model(ctx: &mut CommandContext) -> CommandResult {
    let char_name = require_character(ctx)?.to_owned();
    let mut prefs = load_char_prefs(ctx, &char_name)?;
    let previous = prefs.selected.clone();
    prefs.selected = preferences::SelectedModel::default();
    save_char_prefs(ctx, &char_name, &prefs)?;

    let previous_active = ctx.active_model.take();
    ctx.active_resolved_model = None;
    info!(
        character = %char_name,
        previous = ?previous_active,
        "Model selection reset"
    );
    Ok(json!({
        "previous": previous_active,
        "previous_provider": previous.provider,
        "previous_model_id": previous.model_id,
        "active": ctx.active_model,
        "reset_to": "config default",
    }))
}

/// Set a single sampler/setting field on the active model's preferences.
///
/// Args:
/// - `key`: one of `temperature`, `top_p`, `reasoning_effort`,
///   `budget_tokens`, `max_output_tokens`, `cache_ttl`, `cache_keepalive`,
///   `sdk`, `replay_prior_thinking`, `max_tool_iterations`.
/// - `value`: a number/string/bool/null. `null` removes the setting.
/// - `scope`: `"character"` (default) or `"global"`.
pub fn set_model_setting(ctx: &mut CommandContext, args: &Value) -> CommandResult {
    let key = args
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or((ErrorCode::InvalidRequest, "missing key".into()))?
        .trim()
        .to_owned();
    if !SAMPLER_KEYS.contains(&key.as_str()) {
        return Err((
            ErrorCode::InvalidRequest,
            format!(
                "unknown setting key: {key}; supported: {}",
                SAMPLER_KEYS.join(", ")
            ),
        ));
    }
    let value = args.get("value").cloned().unwrap_or(Value::Null);
    let scope = args
        .get("scope")
        .and_then(|v| v.as_str())
        .unwrap_or("character");
    if scope != "character" && scope != "global" {
        return Err((
            ErrorCode::InvalidRequest,
            format!("scope must be \"character\" or \"global\", got {scope:?}"),
        ));
    }

    // Resolve the model whose preference entry we key: a `background_task`
    // selector targets that purpose's model, otherwise the active chat model.
    let active = resolve_setting_target(ctx, args)?;
    let provider = active.provider_key.clone();
    let model_id = active.model_id.clone();
    let qualified = active.qualified_name.clone();

    // Capability boundary (#162): reject keys the resolved sdk ignores/rejects
    // and out-of-domain values *before* they reach the preference file (and
    // later the wire). Keys with no matrix field — `sdk`,
    // `max_tool_iterations` — are Shore behaviors / transport and skip this.
    capability_check(&active.sdk, &model_id, &key, &value)?;

    // Load the appropriate preferences file.
    let mut prefs = if scope == "global" {
        preferences::load_preferences(&preferences::global_preferences_path(&ctx.data_dir))
            .map_err(|e| (ErrorCode::InternalError, e.to_string()))?
    } else {
        let char_name = require_character(ctx)?;
        load_char_prefs(ctx, char_name)?
    };

    let entry = prefs
        .models
        .entry(preferences::preference_key(&provider, &model_id))
        .or_default();

    // Apply the value. Null clears the field.
    apply_sampler_value(&mut entry.sampler, &key, &value)?;

    // If the entry's sampler is now fully empty, drop it to keep the
    // file tidy.
    if entry.sampler == SamplerSettings::default() {
        let _ignored = prefs
            .models
            .remove(&preferences::preference_key(&provider, &model_id));
    }

    if scope == "global" {
        preferences::save_global_preferences(&ctx.data_dir, &prefs)
            .map_err(|e| (ErrorCode::InternalError, e.to_string()))?;
    } else {
        let char_name = require_character(ctx)?.to_owned();
        save_char_prefs(ctx, &char_name, &prefs)?;
    }

    info!(
        scope,
        key = %key,
        ?value,
        model = %qualified,
        "Model setting updated"
    );
    Ok(json!({
        "changed": true,
        "scope": scope,
        "model": qualified,
        "provider": provider,
        "model_id": model_id,
        "key": key,
        "value": value,
    }))
}

/// Reject a setting the model's resolved `sdk` cannot honor, sourcing the
/// message from [`shore_config::capabilities`] (#162). Returns `Ok(())` for
/// keys outside the capability matrix (`sdk`, `max_tool_iterations`) and for
/// clearing a value (`null`).
fn capability_check(
    sdk: &shore_config::models::Sdk,
    model_id: &str,
    key: &str,
    value: &Value,
) -> Result<(), (ErrorCode, String)> {
    use shore_config::capabilities::{self, Field};

    // Clearing (`--reset`) is always allowed — there is no value to validate.
    if value.is_null() {
        return Ok(());
    }
    let Some(field) = Field::from_key(key) else {
        return Ok(());
    };

    // The reasoning-effort disable sentinel ("off") is not a wire value — the
    // overlay suppresses reasoning rather than sending it — so it is absent from
    // the graded sdk domains (Moonshot, whose only accepted value IS `off`, lists
    // it explicitly). Skip the value-domain check for it and gate only
    // applicability — BUT only for sdks whose adapter actually honors the
    // off-switch (`capabilities::supports_reasoning_off`). On sdks without a
    // disable path (native openai/gemini), `"off"` would silently no-op, so we
    // let it fall through to the value-domain check, which rejects it as
    // out-of-domain (#164, CodeRabbit review).
    let reasoning_off = field == Field::ReasoningEffort
        && value.as_str() == Some("off")
        && capabilities::supports_reasoning_off(sdk);

    // `validate` only inspects the value for `reasoning_effort` (a string
    // domain); for every other field a placeholder is sufficient, since the
    // check there is pure applicability.
    let probe = match value.as_str() {
        Some(s) if !reasoning_off => toml::Value::String(s.to_owned()),
        _ => toml::Value::Boolean(true),
    };
    capabilities::validate(sdk, model_id, field, &probe)
        .map_err(|e| (ErrorCode::InvalidRequest, e.to_string()))
}

#[expect(
    clippy::too_many_lines,
    reason = "maps every sampler key to its SamplerSettings field with validation"
)]
fn apply_sampler_value(
    sampler: &mut SamplerSettings,
    key: &str,
    value: &Value,
) -> Result<(), (ErrorCode, String)> {
    let invalid = |msg: String| (ErrorCode::InvalidRequest, msg);
    let is_null = value.is_null();
    match key {
        "temperature" => {
            sampler.temperature =
                if is_null {
                    None
                } else {
                    Some(value.as_f64().ok_or_else(|| {
                        invalid(format!("temperature must be a number, got {value}"))
                    })?)
                };
        }
        "top_p" => {
            sampler.top_p = if is_null {
                None
            } else {
                Some(
                    value
                        .as_f64()
                        .ok_or_else(|| invalid(format!("top_p must be a number, got {value}")))?,
                )
            };
        }
        "reasoning_effort" => {
            sampler.reasoning_effort = if is_null {
                None
            } else {
                Some(
                    value
                        .as_str()
                        .ok_or_else(|| {
                            invalid(format!("reasoning_effort must be a string, got {value}"))
                        })?
                        .to_owned(),
                )
            };
        }
        "budget_tokens" => {
            sampler.budget_tokens = if is_null {
                None
            } else {
                Some(parse_u32_value(value, "budget_tokens")?)
            };
        }
        "max_output_tokens" => {
            sampler.max_output_tokens = if is_null {
                None
            } else {
                Some(parse_u32_value(value, "max_output_tokens")?)
            };
        }
        "cache_ttl" => {
            sampler.cache_ttl = if is_null {
                None
            } else {
                Some(
                    value
                        .as_str()
                        .ok_or_else(|| invalid(format!("cache_ttl must be a string, got {value}")))?
                        .to_owned(),
                )
            };
        }
        "cache_keepalive" => {
            sampler.cache_keepalive = if is_null {
                None
            } else {
                let s = value.as_str().ok_or_else(|| {
                    invalid(format!("cache_keepalive must be a string, got {value}"))
                })?;
                Some(
                    shore_config::models::CacheKeepaliveSetting::parse(s)
                        .map_err(|e| invalid(format!("cache_keepalive: {e}")))?,
                )
            };
        }
        "sdk" => {
            sampler.sdk = parse_sdk_override(value)?;
        }
        "replay_prior_thinking" => {
            sampler.replay_prior_thinking = parse_thinking_replay_value(value)?;
        }
        "max_tool_iterations" => {
            sampler.max_tool_iterations = if is_null {
                // null/unset → unlimited (the default).
                None
            } else {
                let n = parse_u32_value(value, "max_tool_iterations")?;
                if n == 0 {
                    return Err(invalid(
                        "max_tool_iterations must be >= 1; unset it (null) for unlimited"
                            .to_owned(),
                    ));
                }
                Some(n)
            };
        }
        _ => return apply_vendor_sampler_value(sampler, key, value),
    }
    Ok(())
}

/// Parse/validate an `sdk` override string. `null` clears it. Unknown SDK
/// strings are rejected up-front so the preferences file never carries a value
/// `apply_sampler_overlay` would have to discard at request time.
fn parse_sdk_override(value: &Value) -> Result<Option<String>, (ErrorCode, String)> {
    let invalid = |msg: String| (ErrorCode::InvalidRequest, msg);
    if value.is_null() {
        return Ok(None);
    }
    let s = value
        .as_str()
        .ok_or_else(|| invalid(format!("sdk must be a string, got {value}")))?;
    if shore_config::models::Sdk::parse_wire(s).is_none() {
        return Err(invalid(format!(
            "sdk must be one of \"anthropic\", \"openai\", \"gemini\", \"zai\"; got {s:?}"
        )));
    }
    Ok(Some(s.to_owned()))
}

/// Parse/store the vendor knobs (`openrouter_provider`, `vertex_*`, `gemini_*`,
/// `zai_*`). Split out of [`apply_sampler_value`] to keep each function small.
fn apply_vendor_sampler_value(
    sampler: &mut SamplerSettings,
    key: &str,
    value: &Value,
) -> Result<(), (ErrorCode, String)> {
    let invalid = |msg: String| (ErrorCode::InvalidRequest, msg);
    match key {
        "openrouter_provider" => {
            sampler.openrouter_provider = if value.is_null() {
                None
            } else {
                // Routing is an object (`{ order, allow_fallbacks, ... }`); a
                // scalar would be stored verbatim but mean nothing on the wire.
                if !value.is_object() {
                    return Err(invalid(format!(
                        "openrouter_provider must be a routing object, got {value}"
                    )));
                }
                // The object arrives as JSON over SWP; store it as the
                // `toml::Value` the catalog/overlay expects.
                Some(toml::Value::try_from(value).map_err(|e| {
                    invalid(format!(
                        "openrouter_provider must be a TOML-compatible object: {e}"
                    ))
                })?)
            };
        }
        "vertex_project" => {
            sampler.vertex_project = parse_string_value(value, "vertex_project")?;
        }
        "vertex_location" => {
            sampler.vertex_location = parse_string_value(value, "vertex_location")?;
        }
        "gemini_generation" => {
            sampler.gemini_generation = if value.is_null() {
                None
            } else {
                Some(parse_u32_value(value, "gemini_generation")?)
            };
        }
        "gemini_web_search" => {
            sampler.gemini_web_search = parse_bool_value(value, "gemini_web_search")?;
        }
        "zai_clear_thinking" => {
            sampler.zai_clear_thinking = parse_bool_value(value, "zai_clear_thinking")?;
        }
        "zai_subscription" => {
            sampler.zai_subscription = parse_bool_value(value, "zai_subscription")?;
        }
        _ => return Err(invalid(format!("unknown setting key: {key}"))),
    }
    Ok(())
}

/// Parse an optional string setting value. `null` clears the field.
fn parse_string_value(value: &Value, name: &str) -> Result<Option<String>, (ErrorCode, String)> {
    if value.is_null() {
        return Ok(None);
    }
    value.as_str().map(|s| Some(s.to_owned())).ok_or_else(|| {
        (
            ErrorCode::InvalidRequest,
            format!("{name} must be a string, got {value}"),
        )
    })
}

/// Parse an optional boolean setting value. `null` clears the field
/// (returns `None`); any non-boolean is rejected.
fn parse_bool_value(value: &Value, name: &str) -> Result<Option<bool>, (ErrorCode, String)> {
    if value.is_null() {
        return Ok(None);
    }
    value.as_bool().map(Some).ok_or_else(|| {
        (
            ErrorCode::InvalidRequest,
            format!("{name} must be a boolean, got {value}"),
        )
    })
}

/// Parse the tri-state `replay_prior_thinking` value (#191): `null` clears the
/// override; the string form (`all` | `last_turn` | `none`) and the legacy
/// bool (`true` → all, `false` → none) are both accepted.
fn parse_thinking_replay_value(
    value: &Value,
) -> Result<Option<shore_config::app::ThinkingReplay>, (ErrorCode, String)> {
    use shore_config::app::ThinkingReplay;
    if value.is_null() {
        return Ok(None);
    }
    if let Some(b) = value.as_bool() {
        return Ok(Some(if b {
            ThinkingReplay::All
        } else {
            ThinkingReplay::None
        }));
    }
    let s = value.as_str().ok_or_else(|| {
        (
            ErrorCode::InvalidRequest,
            format!(
                "replay_prior_thinking must be \"all\", \"last_turn\", or \"none\"; got {value}"
            ),
        )
    })?;
    ThinkingReplay::parse_wire(s).map(Some).ok_or_else(|| {
        (
            ErrorCode::InvalidRequest,
            format!("replay_prior_thinking must be \"all\", \"last_turn\", or \"none\"; got {s:?}"),
        )
    })
}

fn parse_u32_value(value: &Value, name: &str) -> Result<u32, (ErrorCode, String)> {
    value
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| {
            (
                ErrorCode::InvalidRequest,
                format!("{name} must be a non-negative integer fitting in u32, got {value}"),
            )
        })
}

/// Return effective sampler settings + scope info for the active model.
pub fn model_settings(ctx: &CommandContext, args: &Value) -> CommandResult {
    let active = resolve_setting_target(ctx, args)?;

    let char_name = ctx.character_name.as_deref();
    let (global, char_prefs) = match char_name {
        Some(c) => preferences::load_for_character(&ctx.data_dir, c)
            .map_err(|e| (ErrorCode::InternalError, e.to_string()))?,
        None => (ModelPreferences::default(), ModelPreferences::default()),
    };
    let char_prefs_opt = if char_name.is_some() {
        Some(&char_prefs)
    } else {
        None
    };
    let sampler = preferences::resolve_sampler_settings(
        &global,
        char_prefs_opt,
        &active.provider_key,
        &active.model_id,
        Some(&active),
    );
    let scopes = preferences::resolve_sampler_scopes(
        &global,
        char_prefs_opt,
        &active.provider_key,
        &active.model_id,
        Some(&active),
    );
    let saved_global = global
        .model(&active.provider_key, &active.model_id)
        .cloned();
    let saved_character = char_prefs
        .model(&active.provider_key, &active.model_id)
        .cloned();

    Ok(json!({
        "model": active.qualified_name,
        "provider": active.provider_key,
        "model_id": active.model_id,
        "effective_sampler": sampler,
        "saved_global": saved_global.map(|p| p.sampler),
        "saved_character": saved_character.map(|p| p.sampler),
        // Capability matrix (#162): how the resolved sdk treats each key, so
        // clients can hide keys the model ignores/rejects, plus the accepted
        // `reasoning_effort` value set for the sdk.
        "applicability": key_applicability(&active.sdk, &active.model_id),
        "reasoning_effort_domain": shore_config::capabilities::reasoning_effort_domain(&active.sdk, &active.model_id),
        "scopes": {
            "temperature": scopes.temperature.map(scope_str),
            "top_p": scopes.top_p.map(scope_str),
            "reasoning_effort": scopes.reasoning_effort.map(scope_str),
            "budget_tokens": scopes.budget_tokens.map(scope_str),
            "max_output_tokens": scopes.max_output_tokens.map(scope_str),
            "cache_ttl": scopes.cache_ttl.map(scope_str),
            "cache_keepalive": scopes.cache_keepalive.map(scope_str),
            "sdk": scopes.sdk.map(scope_str),
            "replay_prior_thinking": scopes.replay_prior_thinking.map(scope_str),
            "max_tool_iterations": scopes.max_tool_iterations.map(scope_str),
            "openrouter_provider": scopes.openrouter_provider.map(scope_str),
            "vertex_project": scopes.vertex_project.map(scope_str),
            "vertex_location": scopes.vertex_location.map(scope_str),
            "gemini_generation": scopes.gemini_generation.map(scope_str),
            "gemini_web_search": scopes.gemini_web_search.map(scope_str),
            "zai_clear_thinking": scopes.zai_clear_thinking.map(scope_str),
            "zai_subscription": scopes.zai_subscription.map(scope_str),
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_tool_iterations_setting_parses_validates_and_clears() {
        let mut s = SamplerSettings::default();

        // A finite value is stored.
        apply_sampler_value(&mut s, "max_tool_iterations", &json!(5)).unwrap();
        assert_eq!(s.max_tool_iterations, Some(5));

        // null clears back to unlimited (None).
        apply_sampler_value(&mut s, "max_tool_iterations", &Value::Null).unwrap();
        assert_eq!(s.max_tool_iterations, None);

        // 0 is rejected — unlimited is expressed by unsetting, not by 0.
        let err = apply_sampler_value(&mut s, "max_tool_iterations", &json!(0)).unwrap_err();
        assert_eq!(err.0, ErrorCode::InvalidRequest);
        assert!(err.1.contains("max_tool_iterations"));
        assert_eq!(s.max_tool_iterations, None);
    }

    #[test]
    fn max_tool_iterations_is_an_accepted_sampler_key_always_applicable() {
        assert!(SAMPLER_KEYS.contains(&"max_tool_iterations"));
        // Not a capability-matrix field, so it is "always" applicable on any sdk.
        let applicability = key_applicability(&shore_config::models::Sdk::Openai, "gpt-test");
        assert_eq!(applicability["max_tool_iterations"], json!("always"));
    }

    #[test]
    fn cache_keepalive_setting_parses_validates_and_clears() {
        use shore_config::models::CacheKeepaliveSetting;
        let mut s = SamplerSettings::default();

        // A duration string is parsed into the typed setting.
        apply_sampler_value(&mut s, "cache_keepalive", &json!("30m")).unwrap();
        assert!(matches!(
            s.cache_keepalive,
            Some(CacheKeepaliveSetting::Every(_))
        ));

        // The "off" sentinel disables keepalive.
        apply_sampler_value(&mut s, "cache_keepalive", &json!("off")).unwrap();
        assert_eq!(s.cache_keepalive, Some(CacheKeepaliveSetting::Off));

        // null clears back to inheriting the sdk default.
        apply_sampler_value(&mut s, "cache_keepalive", &Value::Null).unwrap();
        assert_eq!(s.cache_keepalive, None);

        // A zero interval is rejected (would spin a ping loop; use "off").
        let err = apply_sampler_value(&mut s, "cache_keepalive", &json!("0s")).unwrap_err();
        assert_eq!(err.0, ErrorCode::InvalidRequest);
        assert!(err.1.contains("cache_keepalive"));
        assert_eq!(s.cache_keepalive, None);
    }

    #[test]
    fn cache_keepalive_is_an_accepted_sampler_key_honored_everywhere() {
        assert!(SAMPLER_KEYS.contains(&"cache_keepalive"));
        // `Field::CacheKeepalive` is Honored on every sdk (daemon-side cadence).
        let applicability = key_applicability(&shore_config::models::Sdk::Openai, "gpt-test");
        assert_eq!(applicability["cache_keepalive"], json!("honored"));
    }
}
