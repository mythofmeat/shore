export const TIERS = ["inline", "settings", "advanced"] as const;
export type Tier = (typeof TIERS)[number];

const inline = (...targets: string[]) => Object.fromEntries(targets.map((target) => [target, "inline" as const]));
const settings = (...targets: string[]) => Object.fromEntries(targets.map((target) => [target, "settings" as const]));

export const SURFACES: Readonly<Record<string, Tier>> = {
  ...inline(
    "switch_character", "switch_character.name", "switch_thread", "switch_thread.name",
    "message", "message.text", "message.image_data", "@attachments", "inject_system", "inject_system.text",
    "regen", "regen.guidance",
    "alt", "alt.direction", "alt.position", "alt.ref", "list_alternatives", "list_alternatives.ref",
    "edit", "edit.ref", "edit.content", "get", "get.ref", "@editor",
    "delete", "delete.refs",
    "@follow", "@content", "@thinking", "@tools", "@subagents",
    "compact", "compact.keep_turns", "compact.restart", "clear", "clear.exclude", "clear.note",
    "list_characters", "create_character", "create_character.name",
    "list_threads", "create_thread", "create_thread.name", "create_thread.label", "create_thread.model", "create_thread.compaction",
    "thread_label", "thread_label.name", "thread_label.label", "thread_model", "thread_model.name", "thread_model.model",
    "thread_home", "thread_home.name", "archive_thread", "archive_thread.name",
    "fork_thread", "fork_thread.name", "fork_thread.from", "fork_thread.turns",
    "switch_model", "switch_model.name", "@chat_role", "list_models", "list_models.include_hidden", "favorite_model", "favorite_model.name",
    "local:image", "local:cancel", "local:edit_cancel", "local:editor",
    "request:message", "request:message.text", "request:message.image_data", "request:regen", "request:regen.guidance", "request:cancel",
  ),
  ...settings(
    "view:timestamps", "view:thinking", "view:tools", "view:subagent", "view:images", "view:metadata", "view:compaction",
    "local:quit",
  ),
  "renderer:compaction_status": "inline",
};
