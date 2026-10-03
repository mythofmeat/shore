export const TIERS = ["inline", "settings", "advanced"] as const;
export type Tier = (typeof TIERS)[number];

const tier = (level: Tier) => (...targets: string[]) => Object.fromEntries(targets.map((target) => [target, level]));
const inline = tier("inline");
const settings = tier("settings");
const advanced = tier("advanced");

export const SURFACES: Readonly<Record<string, Tier>> = {
  ...inline(
    "switch_character", "switch_character.name", "switch_thread", "switch_thread.name",
    "message", "message.text", "message.image_data", "message.images", "request:message.images", "@attachments", "inject_system", "inject_system.text",
    "regen", "regen.guidance",
    "alt", "alt.direction", "alt.position", "alt.ref", "list_alternatives", "list_alternatives.ref",
    "edit", "edit.ref", "edit.content", "get", "get.ref", "@editor",
    "delete", "delete.refs",
    "@follow", "@content", "@thinking", "@tools", "@subagents", "history_page", "history_page.segment",
    "compact", "compact.keep_turns", "compact.restart", "compact_watch", "compact_cancel", "@compaction_watch", "@compaction_cancel", "clear", "clear.exclude", "clear.note",
    "list_characters", "create_character", "create_character.name",
    "list_threads", "create_thread", "create_thread.name", "create_thread.label", "create_thread.model", "create_thread.compaction",
    "thread_label", "thread_label.name", "thread_label.label", "thread_model", "thread_model.name", "thread_model.model",
    "thread_home", "thread_home.name", "archive_thread", "archive_thread.name",
    "fork_thread", "fork_thread.name", "fork_thread.from", "fork_thread.turns",
    "switch_model", "switch_model.name", "@chat_role", "list_models", "list_models.include_hidden", "list_models.favorites_only", "favorite_model", "favorite_model.name",
    "local:images", "local:subagents", "local:palette", "local:image", "local:cancel", "local:edit_cancel", "local:editor", "local:insert", "local:normal", "local:scroll", "local:segment", "local:help",
    "request:message", "request:message.text", "request:message.image_data", "request:regen", "request:regen.guidance", "request:cancel",
    "renderer:compaction_status",
  ),
  ...settings(
    "view:timestamps", "view:thinking", "view:tools", "view:subagent", "view:images", "view:metadata", "view:compaction", "view:usage", "view:budget", "@display",
    "local:quit", "request:message.stream", "request:regen.stream",
    "character_info", "@character_info", "delete_character", "delete_character.character", "delete_character.confirm", "delete_character.archive", "@confirmation",
    "model_info", "model_info.name", "model_info.background_task", "model_info.subagent", "@model_info",
    "reset_model", "reset_model.background_task", "reset_model.subagent", "@model_reset",
    "switch_model.background_task", "switch_model.subagent",
    "model_settings", "model_settings.key", "set_model_setting", "set_model_setting.key", "set_model_setting.value", "set_model_setting.scope", "set_model_setting.name",
    "set_model_setting.background_task", "set_model_setting.subagent",
    "list_providers", "list_provider_models", "list_provider_models.provider", "list_provider_models.include_hidden",
    "refresh_provider_models", "refresh_provider_models.provider", "refresh_all_provider_models",
    "usage", "usage.last", "usage.provider", "usage.api_key", "usage.model", "usage.call_type", "usage.group_by", "usage.export_tsv", "@usage_export",
    "config", "config.key", "config.value", "config_check", "config_schema", "config_reload", "config_reload.apply", "config_reload.refresh_prompts", "tools",
    "@config_path", "@config_check", "@config_defaults", "@config_filter",
    "renderer:field", "renderer:usage_mode",
  ),
  ...advanced(
    "segments", "segments.index", "segments.value",
    "call_log", "call_log.id", "call_log.count", "call_log.call_type", "call_log.diff", "call_log.against", "call_log.wire",
    "transcript", "transcript.count", "heartbeat_log", "heartbeat_log.count", "error_log", "error_log.count",
    "subagent_trace", "subagent_trace.ids", "subagent_trace.count",
    "log", "log.turns", "log.role",
    "status", "@status_section",
    "run_tool", "run_tool.tool", "run_tool.pairs", "run_tool.input", "run_tool.describe", "run_tool.raw", "@subagent_tool",
    "export_character", "export_character.character", "export_character.output", "import_character", "import_character.archive", "@archives",
    "heartbeat_tick_now", "heartbeat_set_dormant", "heartbeat_set_active", "keepalive_ping_now", "session_activate",
    "renderer:request_phase", "renderer:archive_phase",
  ),
};
