use serde_json::json;
use shore_config::{
    character_data_dir, character_workspace_dir, AGENTS_FILE, SOUL_FILE, TOOLS_FILE, USER_FILE,
};
use shore_protocol::error::ErrorCode;
use shore_protocol::types::{CharacterAvatar, CharacterInfo};
use tracing::{debug, info};

use super::{CommandContext, CommandResult};
use crate::engine::ConversationEngine;

/// List available characters by scanning the config characters directory.
pub fn list_characters(engine: &ConversationEngine, ctx: &CommandContext) -> CommandResult {
    let mut characters = vec![character_metadata(
        &ctx.config.dirs.config,
        engine.character_name(),
    )];

    for name in shore_config::discover_characters(&ctx.config.dirs.config) {
        if name != engine.character_name() {
            characters.push(character_metadata(&ctx.config.dirs.config, &name));
        }
    }

    debug!(count = characters.len(), "Listed characters");
    Ok(json!({ "characters": characters }))
}

/// List characters without requiring an active engine (for use before
/// character resolution, e.g. when multiple characters are available).
pub fn list_characters_standalone(ctx: &CommandContext) -> CommandResult {
    let characters: Vec<CharacterInfo> = shore_config::discover_characters(&ctx.config.dirs.config)
        .into_iter()
        .map(|name| character_metadata(&ctx.config.dirs.config, &name))
        .collect();

    debug!(count = characters.len(), "Listed characters (standalone)");
    Ok(json!({ "characters": characters }))
}

pub(crate) fn character_metadata(config_dir: &std::path::Path, name: &str) -> CharacterInfo {
    CharacterInfo {
        name: name.to_owned(),
        avatar: character_avatar(config_dir, name),
    }
}

fn character_avatar(config_dir: &std::path::Path, name: &str) -> Option<CharacterAvatar> {
    for (filename, mime_type) in [
        ("avatar.png", "image/png"),
        ("avatar.jpg", "image/jpeg"),
        ("avatar.jpeg", "image/jpeg"),
        ("avatar.webp", "image/webp"),
    ] {
        let path = config_dir.join("characters").join(name).join(filename);
        if !path.is_file() {
            continue;
        }
        let Ok(data) = std::fs::read(&path) else {
            continue;
        };
        if data.is_empty() {
            continue;
        }
        return Some(CharacterAvatar {
            mime_type: mime_type.to_owned(),
            data: {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(data)
            },
        });
    }
    None
}

/// Show detailed info about a character's workspace bootstrap files.
pub fn character_info(
    engine: &ConversationEngine,
    ctx: &CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| engine.character_name());

    let char_dir = ctx.config.dirs.config.join("characters").join(name);

    if !char_dir.exists() && name != engine.character_name() {
        return Err((ErrorCode::NotFound, format!("Character not found: {name}")));
    }

    let workspace_dir = character_workspace_dir(&ctx.config.dirs.config, name);
    let definition_path = workspace_dir.join(SOUL_FILE);
    let has_definition = definition_path.exists();
    let definition_preview = if has_definition {
        std::fs::read_to_string(&definition_path)
            .ok()
            .map(|s| s.chars().take(500).collect::<String>())
    } else {
        None
    };

    let bootstrap_files = [SOUL_FILE, USER_FILE, AGENTS_FILE, TOOLS_FILE]
        .into_iter()
        .filter(|file| workspace_dir.join(file).exists())
        .map(str::to_owned)
        .collect::<Vec<_>>();

    let config_override_path = char_dir.join("config.toml");
    let has_config_override = config_override_path.exists();

    let data_dir = character_data_dir(&ctx.data_dir, name);
    let has_data = data_dir.exists();
    let pending_deferred_edits =
        crate::memory::deferred_edits::pending_deferred_edit_paths(&data_dir).unwrap_or_default();

    debug!(
        character = name,
        has_definition,
        has_config_override,
        bootstrap_file_count = bootstrap_files.len(),
        "Character info queried"
    );
    Ok(json!({
        "name": name,
        "active": name == engine.character_name(),
        "config_dir": char_dir.display().to_string(),
        "workspace_dir": workspace_dir.display().to_string(),
        "has_definition": has_definition,
        "definition_preview": definition_preview,
        "bootstrap_files": bootstrap_files,
        "has_config_override": has_config_override,
        "pending_deferred_edits": pending_deferred_edits,
        "data_dir": data_dir.display().to_string(),
        "has_data": has_data,
    }))
}

/// Switch to a different character. In multi-character mode, this is handled
/// by the registry — this command validates the character exists.
pub fn switch_character(
    engine: &ConversationEngine,
    ctx: &mut CommandContext,
    args: &serde_json::Value,
) -> CommandResult {
    let name = args.get("name").and_then(|v| v.as_str()).ok_or_else(|| {
        (
            ErrorCode::InvalidRequest,
            "Missing required argument: name".into(),
        )
    })?;

    if name == engine.character_name() {
        return Ok(json!({ "character": name, "changed": false }));
    }

    // Verify character directory exists.
    let char_dir = ctx.config.dirs.config.join("characters").join(name);
    if !char_dir.exists() {
        return Err((ErrorCode::NotFound, format!("Character not found: {name}")));
    }

    info!(character = name, "Character switch requested");

    Ok(json!({ "character": name, "changed": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::SessionTokens;
    use serde_json::Value;
    use shore_config::app::{AutonomyConfig, CompactionConfig};
    use shore_protocol::server_msg::ServerMessage;
    use tempfile::TempDir;
    use tokio::sync::broadcast;

    fn field<'val>(value: &'val Value, key: &str) -> &'val Value {
        value
            .get(key)
            .unwrap_or_else(|| panic!("missing field {key}"))
    }

    fn array_field<'val>(value: &'val Value, key: &str) -> &'val [Value] {
        field(value, key).as_array().expect("array field")
    }

    fn item<T>(values: &[T], index: usize) -> &T {
        values.get(index).expect("value item")
    }

    fn make_ctx(
        tmp: &TempDir,
    ) -> (
        ConversationEngine,
        CommandContext,
        broadcast::Receiver<ServerMessage>,
    ) {
        let (push_tx, push_rx) = broadcast::channel(16);
        let data_dir = tmp.path().to_path_buf();
        let engine =
            ConversationEngine::new("TestChar".to_owned(), data_dir.clone(), push_tx.clone())
                .unwrap();

        let config = shore_config::LoadedConfig::new_for_test(
            shore_config::app::AppConfig::default(),
            shore_config::models::ModelCatalog::default(),
            shore_config::ShoreDirs {
                config: tmp.path().join("config"),
                data: data_dir.clone(),
                runtime: tmp.path().join("runtime"),
                cache: tmp.path().join("cache"),
            },
        );

        let (_tx, rx) = tokio::sync::watch::channel(());
        let autonomy = crate::autonomy::manager::AutonomyManager::new(
            AutonomyConfig::default(),
            CompactionConfig::default(),
            data_dir.clone(),
            rx,
        );

        let ctx = CommandContext {
            config_path: config.dirs.config.join("config.toml"),
            config,
            push_tx,
            data_dir: data_dir.clone(),
            character_name: None,
            active_model: None,
            active_resolved_model: None,
            session_tokens: std::sync::Arc::new(std::sync::Mutex::new(SessionTokens::default())),
            autonomy,
            llm_client: shore_ledger::LedgerClient::new(
                shore_llm::LlmClient::try_new().unwrap(),
                &data_dir.join("ledger.db"),
            )
            .unwrap(),
            diagnostics: std::sync::Arc::new(std::sync::Mutex::new(
                shore_diagnostics::Diagnostics::default(),
            )),
        };
        (engine, ctx, push_rx)
    }

    #[test]
    fn list_characters_includes_active() {
        let tmp = TempDir::new().unwrap();
        let (engine, ctx, _rx) = make_ctx(&tmp);

        let result = list_characters(&engine, &ctx).unwrap();
        let chars = array_field(&result, "characters");
        assert_eq!(chars.len(), 1);
        assert_eq!(field(item(chars, 0), "name"), "TestChar");
    }

    #[test]
    fn list_characters_scans_config_dir() {
        let tmp = TempDir::new().unwrap();
        let (engine, ctx, _rx) = make_ctx(&tmp);

        // Create character directories.
        let chars_dir = tmp.path().join("config").join("characters");
        std::fs::create_dir_all(chars_dir.join("Alice").join("workspace")).unwrap();
        std::fs::create_dir_all(chars_dir.join("Bob").join("workspace")).unwrap();
        // Active character directory (should be deduped).
        std::fs::create_dir_all(chars_dir.join("TestChar").join("workspace")).unwrap();
        std::fs::write(
            chars_dir.join("Alice").join("workspace").join("SOUL.md"),
            "Alice",
        )
        .unwrap();
        std::fs::write(
            chars_dir.join("Bob").join("workspace").join("SOUL.md"),
            "Bob",
        )
        .unwrap();
        std::fs::write(
            chars_dir.join("TestChar").join("workspace").join("SOUL.md"),
            "Test",
        )
        .unwrap();

        let result = list_characters(&engine, &ctx).unwrap();
        let chars = array_field(&result, "characters");
        // TestChar + Alice + Bob (TestChar not duplicated).
        assert_eq!(chars.len(), 3);
        let names: Vec<&str> = chars
            .iter()
            .map(|c| field(c, "name").as_str().unwrap())
            .collect();
        assert!(names.contains(&"TestChar"));
        assert!(names.contains(&"Alice"));
        assert!(names.contains(&"Bob"));
    }

    #[test]
    fn standalone_list_characters_ignores_data_only_dirs() {
        let tmp = TempDir::new().unwrap();
        let (_engine, ctx, _rx) = make_ctx(&tmp);

        let qifei_dir = tmp
            .path()
            .join("config")
            .join("characters")
            .join("qifei")
            .join("workspace");
        std::fs::create_dir_all(&qifei_dir).unwrap();
        std::fs::write(qifei_dir.join("SOUL.md"), "Qifei").unwrap();

        for name in ["debug", "providers", "matrix-server", "matrix-store"] {
            std::fs::create_dir_all(tmp.path().join(name)).unwrap();
        }

        let result = list_characters_standalone(&ctx).unwrap();
        let names: Vec<&str> = array_field(&result, "characters")
            .iter()
            .map(|c| field(c, "name").as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["qifei"]);
    }

    #[test]
    fn character_info_embeds_avatar_data() {
        let tmp = TempDir::new().unwrap();
        let char_dir = tmp.path().join("characters").join("Alice");
        std::fs::create_dir_all(&char_dir).unwrap();
        std::fs::write(char_dir.join("avatar.png"), b"png").unwrap();

        let info = character_metadata(tmp.path(), "Alice");
        let avatar = info.avatar.expect("avatar should be embedded");
        assert_eq!(avatar.mime_type, "image/png");
        assert_eq!(avatar.data, "cG5n");
    }

    #[test]
    fn switch_character_same_is_noop() {
        let tmp = TempDir::new().unwrap();
        let (engine, mut ctx, _rx) = make_ctx(&tmp);

        let result = switch_character(&engine, &mut ctx, &json!({"name": "TestChar"})).unwrap();
        assert_eq!(field(&result, "changed"), false);
    }

    #[test]
    fn switch_character_not_found() {
        let tmp = TempDir::new().unwrap();
        let (engine, mut ctx, _rx) = make_ctx(&tmp);

        let result = switch_character(&engine, &mut ctx, &json!({"name": "Nonexistent"}));
        assert!(result.is_err());
        let (code, _msg) = result.unwrap_err();
        assert_eq!(code, ErrorCode::NotFound);
    }

    #[test]
    fn switch_character_missing_name() {
        let tmp = TempDir::new().unwrap();
        let (engine, mut ctx, _rx) = make_ctx(&tmp);

        let result = switch_character(&engine, &mut ctx, &json!({}));
        assert!(result.is_err());
        let (code, _msg) = result.unwrap_err();
        assert_eq!(code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn character_info_active() {
        let tmp = TempDir::new().unwrap();
        let (engine, ctx, _rx) = make_ctx(&tmp);

        let result = character_info(&engine, &ctx, &json!({})).unwrap();
        assert_eq!(field(&result, "name"), "TestChar");
        assert_eq!(field(&result, "active"), true);
        assert!(!field(&result, "has_definition").as_bool().unwrap());
    }

    #[test]
    fn character_info_with_definition() {
        let tmp = TempDir::new().unwrap();
        let (engine, ctx, _rx) = make_ctx(&tmp);

        // Create character definition.
        let char_dir = tmp
            .path()
            .join("config")
            .join("characters")
            .join("TestChar");
        std::fs::create_dir_all(&char_dir).unwrap();
        let workspace_dir = char_dir.join("workspace");
        std::fs::create_dir_all(&workspace_dir).unwrap();
        std::fs::write(workspace_dir.join("SOUL.md"), "You are a test character.").unwrap();
        std::fs::write(workspace_dir.join("USER.md"), "The user likes tests.").unwrap();

        let result = character_info(&engine, &ctx, &json!({})).unwrap();
        assert!(field(&result, "has_definition").as_bool().unwrap());
        assert!(array_field(&result, "bootstrap_files")
            .iter()
            .any(|v| v == "USER.md"));
        assert!(field(&result, "definition_preview")
            .as_str()
            .unwrap()
            .contains("test character"));
    }

    #[test]
    fn character_info_not_found() {
        let tmp = TempDir::new().unwrap();
        let (engine, ctx, _rx) = make_ctx(&tmp);

        let result = character_info(&engine, &ctx, &json!({"name": "Nonexistent"}));
        assert!(result.is_err());
        let (code, _msg) = result.unwrap_err();
        assert_eq!(code, ErrorCode::NotFound);
    }

    #[test]
    fn character_info_with_prompt_overrides() {
        let tmp = TempDir::new().unwrap();
        let (engine, ctx, _rx) = make_ctx(&tmp);

        let workspace_dir = tmp
            .path()
            .join("config")
            .join("characters")
            .join("TestChar")
            .join("workspace");
        std::fs::create_dir_all(&workspace_dir).unwrap();
        std::fs::write(workspace_dir.join("AGENTS.md"), "override").unwrap();

        let result = character_info(&engine, &ctx, &json!({})).unwrap();
        let bootstrap_files = array_field(&result, "bootstrap_files");
        assert!(bootstrap_files.iter().any(|v| v == "AGENTS.md"));
    }
}
