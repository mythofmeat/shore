use schemars::{JsonSchema, Schema, generate::SchemaSettings};
use serde::{Deserialize, Serialize};

use super::client_msg::Command;
use super::types::{CharacterInfo, ImageRef, Message, Role};

fn deserialize_present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

fn deserialize_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone)]
pub struct ProviderRefreshFlag<const SUCCESS: bool>;

impl<const SUCCESS: bool> Serialize for ProviderRefreshFlag<SUCCESS> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(SUCCESS)
    }
}

impl<'de, const SUCCESS: bool> Deserialize<'de> for ProviderRefreshFlag<SUCCESS> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? == SUCCESS {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("invalid provider refresh outcome"))
        }
    }
}

impl<const SUCCESS: bool> JsonSchema for ProviderRefreshFlag<SUCCESS> {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        if SUCCESS {
            "ProviderRefreshSucceeded".into()
        } else {
            "ProviderRefreshFailed".into()
        }
    }

    fn json_schema(_generator: &mut schemars::SchemaGenerator) -> Schema {
        schemars::json_schema!({ "type": "boolean", "const": SUCCESS })
    }
}

macro_rules! wire_types {
    ($($item:item)*) => {$ (
        #[derive(Serialize, Deserialize, Debug, Clone, JsonSchema, ts_rs::TS)]
        #[ts(export, export_to = "../../../daemon/src/protocol/")]
        $item
    )*};
}

wire_types! {
    pub enum OperationCategory { Application, Characters, Threads, Conversation, Providers, Configuration }

    #[serde(rename_all = "snake_case")]
    pub enum OperationScope { Global, Selection, Character, OptionalCharacter }

    #[serde(rename_all = "snake_case")]
    pub enum OperationPrerequisite { Threads }

    #[serde(rename_all = "snake_case")]
    pub enum OperationEffect { Read, WorkspaceWrite, HistoryWrite, Selection, ModelSelection, ProviderDiscovery, ConfigWrite }

    #[serde(rename_all = "snake_case")]
    pub enum OperationConfirmation { None, Archive, Delete }

    #[serde(rename_all = "snake_case")]
    pub enum OperationChoices { Characters, Threads, Models, Providers, ConfigKeys }

    pub struct OperationField {
        pub label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub hint: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub choices: Option<OperationChoices>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub multiline: Option<bool>,
    }

    pub struct OperationDescriptor {
        pub name: String,
        pub label: String,
        pub category: OperationCategory,
        pub scope: OperationScope,
        pub prerequisites: Vec<OperationPrerequisite>,
        pub effects: Vec<OperationEffect>,
        pub confirmation: OperationConfirmation,
        pub fields: std::collections::BTreeMap<String, OperationField>,
        #[ts(type = "unknown")]
        pub input: serde_json::Value,
        #[ts(type = "unknown")]
        pub output: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub available: Option<bool>,
    }

    pub struct OperationCatalogue { pub operations: Vec<OperationDescriptor> }

    #[serde(rename_all = "snake_case")]
    pub enum ConfigKind { Boolean, String, Integer, Float, Duration, Enum, List, Map, Table, Unknown }

    #[serde(rename_all = "snake_case")]
    pub enum ConfigSource { ChatModels, EmbeddingModels, ImageModels, Tools, Subagents, Characters, Providers }

    #[serde(rename_all = "lowercase")]
    pub enum ConfigWidth { Usize, U32, U64 }

    pub struct ConfigSchemaEntry {
        pub key: String,
        pub kind: ConfigKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub item_kind: Option<ConfigKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub width: Option<ConfigWidth>,
        pub r#type: String,
        pub settable: bool,
        pub optional: bool,
        pub restart_required: bool,
        pub secret: bool,
        pub values: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub source: Option<ConfigSource>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub key_source: Option<ConfigSource>,
    }

    pub struct ConfigSources {
        pub chat_models: Vec<String>, pub embedding_models: Vec<String>, pub image_models: Vec<String>,
        pub tools: Vec<String>, pub subagents: Vec<String>, pub characters: Vec<String>, pub providers: Vec<String>,
    }

    pub struct ConfigSchemaResult { pub schema: Vec<ConfigSchemaEntry>, pub sources: ConfigSources }

    #[serde(deny_unknown_fields)]
    pub struct ConfigArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub value: Option<String>,
    }

    #[serde(deny_unknown_fields)]
    pub struct ConfigReloadArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub apply: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub refresh_prompts: Option<bool>,
    }

    pub struct ConfigView {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub key: Option<String>,
        #[ts(type = "unknown")]
        pub config: serde_json::Value,
        #[ts(type = "unknown")]
        pub defaults: serde_json::Value,
    }

    pub struct ConfigInvalidated {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub merged_character_configs: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub character_discovery: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub removed_character_engines: Option<usize>,
    }

    pub struct ConfigSetResult {
        pub set: String,
        #[ts(type = "unknown")]
        pub value: serde_json::Value,
        #[ts(type = "unknown")]
        pub previous: serde_json::Value,
        pub file: String,
        pub action: String,
        pub restart_required: Vec<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub masked_by_preference: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub invalidated: Option<ConfigInvalidated>,
    }

    #[serde(untagged)]
    pub enum ConfigResult { Set(ConfigSetResult), View(ConfigView) }

    pub struct ConfigCheckResult {
        pub valid: bool,
        pub warnings: Vec<String>, pub info: Vec<String>,
        pub config_dir: String, pub data_dir: String, pub cache_dir: String,
        pub chat_models: usize, pub providers: usize,
    }

    pub struct ConfigReloadResult {
        pub applied: bool,
        pub config_path: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub character: Option<String>,
        pub changed_prompt_files: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub prompts_refreshed: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub restart_required: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub invalidated: Option<ConfigInvalidated>,
    }

    pub struct ToolAccess { pub tool: String, pub main: bool, pub subagents: Vec<String> }
    pub struct SubagentAccess {
        pub name: String, pub enabled: bool, pub tools: Vec<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub model: Option<String>,
    }
    pub struct ToolAccessResult { pub tools: Vec<ToolAccess>, pub subagents: Vec<SubagentAccess>, pub mcp: Vec<String>, pub warnings: Vec<String> }

    #[serde(deny_unknown_fields)]
    pub struct ProviderArgs { pub provider: String }

    #[serde(deny_unknown_fields)]
    pub struct ProviderModelsArgs {
        pub provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub include_hidden: Option<bool>,
    }

    pub struct ProviderKeyStatus {
        pub name: String,
        pub enabled: bool,
        pub warn_on_fallback: bool,
        pub env_set: bool,
    }

    pub struct ProviderCacheStatus {
        pub present: bool,
        pub models: usize,
        pub visible: usize,
        pub hidden: usize,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub fetched_at: Option<String>,
    }

    pub struct ProviderStatus {
        pub name: String,
        pub enabled: bool,
        pub sdk: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub base_url: Option<String>,
        pub discovery_enabled: bool,
        pub keys: Vec<ProviderKeyStatus>,
        pub cache: ProviderCacheStatus,
    }

    pub struct ProviderListing { pub providers: Vec<ProviderStatus> }

    #[serde(rename_all = "snake_case")]
    pub enum DiscoveredModelSource { Discovered }

    #[serde(rename_all = "snake_case")]
    pub enum StaticModelSource { Static }

    pub struct ProviderDiscoveredModel {
        pub source: DiscoveredModelSource,
        pub model_id: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub display_name: Option<String>,
        pub sdk: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub owned_by: Option<String>,
        #[ts(type = "number | null")]
        #[serde(deserialize_with = "deserialize_nullable")]
        pub context_length: Option<u64>,
        #[ts(type = "number | null")]
        #[serde(deserialize_with = "deserialize_nullable")]
        pub max_output_tokens: Option<u64>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub supports_tools: Option<bool>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub supports_images: Option<bool>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub supports_reasoning: Option<bool>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub supports_prompt_cache: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub subscription_included: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub subscription_input_multiplier: Option<f64>,
        pub discovered_at: String,
    }

    pub struct ProviderStaticModel {
        pub source: StaticModelSource,
        pub name: String,
        pub qualified_name: String,
        pub model_id: String,
        pub sdk: String,
        #[ts(type = "number | null")]
        #[serde(deserialize_with = "deserialize_nullable")]
        pub max_output_tokens: Option<u64>,
    }

    pub struct ProviderModelCache {
        #[serde(deserialize_with = "deserialize_nullable")]
        pub fetched_at: Option<String>,
        pub model_count: usize,
    }

    pub struct ProviderModelListing {
        pub provider: String,
        pub discovered: Vec<ProviderDiscoveredModel>,
        pub hidden: Vec<ProviderDiscoveredModel>,
        pub r#static: Vec<ProviderStaticModel>,
        pub include_hidden: bool,
        pub cache: ProviderModelCache,
    }

    pub struct ProviderRefreshed {
        pub provider: String,
        pub model_count: usize,
        pub fetched_at: String,
        pub cache_path: String,
    }

    #[serde(untagged)]
    pub enum ProviderRefreshResult {
        Success {
            #[ts(type = "true")]
            ok: ProviderRefreshFlag<true>,
            #[serde(flatten)]
            refreshed: ProviderRefreshed,
        },
        Failure { provider: String, #[ts(type = "false")] ok: ProviderRefreshFlag<false>, error: String },
    }

    pub enum ProviderSkipReason {
        #[serde(rename = "disabled")]
        Disabled,
        #[serde(rename = "discovery disabled")]
        DiscoveryDisabled,
    }

    pub struct ProviderSkipped { pub provider: String, pub reason: ProviderSkipReason }

    pub struct ProvidersRefreshed {
        pub results: Vec<ProviderRefreshResult>,
        pub skipped: Vec<ProviderSkipped>,
    }

    #[serde(deny_unknown_fields)]
    pub struct ConversationLogArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        pub turns: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        pub count: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_present")]
        #[schemars(with = "Role")]
        #[ts(optional)]
        pub role: Option<Role>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum HistoryBoundary { Active }

    #[serde(untagged)]
    pub enum HistoryBefore {
        #[ts(type = "number")]
        Cursor(u64),
        Boundary(HistoryBoundary),
    }

    #[serde(deny_unknown_fields)]
    pub struct HistoryPageArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        pub turns: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        pub count: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_present")]
        #[schemars(with = "Role")]
        #[ts(optional)]
        pub role: Option<Role>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_present")]
        #[schemars(with = "HistoryBefore")]
        #[ts(optional)]
        pub before: Option<HistoryBefore>,
    }

    #[serde(deny_unknown_fields)]
    pub struct GetMessageArgs {
        #[serde(rename = "ref")]
        pub reference: String,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_present")]
        #[schemars(with = "Role")]
        #[ts(optional)]
        pub role: Option<Role>,
    }

    #[serde(deny_unknown_fields)]
    pub struct EditMessageArgs {
        #[serde(rename = "ref")]
        pub reference: String,
        pub content: String,
    }

    #[serde(untagged)]
    pub enum MessageReferences { One(String), Many(Vec<String>) }

    #[serde(deny_unknown_fields)]
    pub struct DeleteMessagesArgs { pub refs: MessageReferences }

    #[serde(deny_unknown_fields)]
    pub struct ListAlternativesArgs {
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "ref")]
        pub reference: Option<String>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum AlternativeDirection { Next, Prev, Previous, First, Last }

    #[serde(deny_unknown_fields)]
    pub struct SelectAlternativeArgs {
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "ref")]
        pub reference: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        pub index: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        pub position: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub direction: Option<AlternativeDirection>,
    }

    #[serde(deny_unknown_fields)]
    pub struct InjectSystemArgs { pub text: String }

    pub struct ConversationPage {
        pub messages: Vec<Message>,
        pub active_start: usize,
        pub cursor: usize,
        pub next_before: usize,
        pub has_more_before: bool,
        pub global_active_start: usize,
        pub total_messages: usize,
        pub total_turns: usize,
    }

    pub struct MessageEdited {
        #[serde(rename = "ref")]
        pub reference: String,
        pub edited: bool,
    }

    pub struct MessagesDeleted { pub deleted: Vec<String> }

    pub struct AlternativeView {
        pub index: usize,
        pub position: usize,
        pub active: bool,
        pub content: String,
        pub images: Vec<ImageRef>,
        pub timestamp: String,
    }

    pub struct AlternativeListing {
        #[serde(rename = "ref")]
        pub reference: String,
        pub alt_index: Option<usize>,
        pub position: Option<usize>,
        pub alt_count: usize,
        pub alternatives: Vec<AlternativeView>,
    }

    pub struct AlternativeSelected {
        #[serde(rename = "ref")]
        pub reference: String,
        pub alt_index: usize,
        pub position: usize,
        pub alt_count: usize,
        pub content: String,
    }

    pub struct SystemInjected { pub injected: bool }

    #[serde(deny_unknown_fields)]
    pub struct EmptyOperationArgs {}

    #[serde(deny_unknown_fields)]
    pub struct NamedOperationArgs {
        pub name: String,
    }

    #[serde(deny_unknown_fields)]
    pub struct CharacterInfoArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub name: Option<String>,
    }

    #[serde(deny_unknown_fields)]
    pub struct CreateThreadArgs {
        pub name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub compaction: Option<bool>,
    }

    #[serde(deny_unknown_fields)]
    pub struct SwitchThreadArgs {
        pub name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub resync: Option<bool>,
    }

    #[serde(deny_unknown_fields)]
    pub struct ThreadLabelArgs {
        pub name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub label: Option<String>,
    }

    #[serde(deny_unknown_fields)]
    pub struct ThreadModelArgs {
        pub name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
    }

    #[serde(deny_unknown_fields)]
    pub struct ForkThreadArgs {
        pub name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(range(min = 1, max = 9007199254740991_u64))]
        #[ts(type = "number | null")]
        pub turns: Option<u64>,
    }

    pub struct CharacterListing {
        pub characters: Vec<CharacterInfo>,
    }

    pub struct CharacterCreated {
        pub character: String,
        pub workspace_dir: String,
        pub config_dir: String,
        pub created_files: Vec<String>,
    }

    pub struct CharacterDetails {
        pub name: String,
        pub active: bool,
        pub config_dir: String,
        pub workspace_dir: String,
        pub has_definition: bool,
        pub definition_preview: Option<String>,
        pub bootstrap_files: Vec<String>,
        pub has_config_override: bool,
        pub pending_deferred_edits: Vec<String>,
        pub data_dir: String,
        pub has_data: bool,
    }

    pub struct CharacterSelection {
        pub character: String,
        pub changed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub selected_character: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub active_model: Option<String>,
    }

    pub struct CacheInvalidation {
        pub cached_request: bool,
    }

    pub struct ThreadSelection {
        pub character: String,
        pub thread: String,
        pub changed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub selected_thread: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub invalidated: Option<CacheInvalidation>,
    }

    pub struct ThreadForkOrigin {
        pub fork_id: String,
        pub source: String,
        pub created_at: String,
        #[ts(type = "number")]
        pub messages: u64,
        #[ts(type = "number")]
        pub turns: u64,
    }

    pub struct ThreadView {
        pub id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub label: Option<String>,
        pub created_at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub last_active: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub chat_model: Option<String>,
        pub compaction: bool,
        pub home: bool,
        pub current: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        pub turns: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub warm: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub forked_from: Option<ThreadForkOrigin>,
    }

    pub struct ThreadListing {
        pub character: String,
        pub threads: Vec<ThreadView>,
        pub home: String,
        pub current: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub invalidated: Option<CacheInvalidation>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum ForkScope {
        Full,
        LastTurns,
    }

    pub struct ThreadForkDetails {
        pub fork_id: String,
        pub thread: String,
        pub source: String,
        pub created_at: String,
        #[ts(type = "number")]
        pub messages: u64,
        #[ts(type = "number")]
        pub turns: u64,
        pub scope: ForkScope,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        pub requested_turns: Option<u64>,
    }

    pub struct ThreadForkResult {
        #[serde(flatten)]
        pub listing: ThreadListing,
        pub fork: ThreadForkDetails,
    }
}

pub trait Operation {
    type Input: Serialize + for<'de> Deserialize<'de> + JsonSchema;
    type Output: Serialize + for<'de> Deserialize<'de> + JsonSchema;
    const NAME: &'static str;

    fn command(input: Self::Input, rid: Option<String>) -> Result<Command, serde_json::Error> {
        Ok(Command {
            rid,
            name: Self::NAME.to_owned(),
            args: serde_json::to_value(input)?,
        })
    }
}

#[derive(Debug, Serialize)]
pub struct OperationSchemas {
    pub name: &'static str,
    pub input: Schema,
    pub output: Schema,
}

fn schemas<O: Operation>() -> OperationSchemas {
    OperationSchemas {
        name: O::NAME,
        input: SchemaSettings::draft2020_12()
            .for_deserialize()
            .into_generator()
            .into_root_schema_for::<O::Input>(),
        output: SchemaSettings::draft2020_12()
            .for_serialize()
            .into_generator()
            .into_root_schema_for::<O::Output>(),
    }
}

macro_rules! operations {
    ($($marker:ident: $name:literal ($input:ty) => $output:ty),* $(,)?) => {
        $(
            #[derive(Debug)]
            pub struct $marker;
            impl Operation for $marker {
                type Input = $input;
                type Output = $output;
                const NAME: &'static str = $name;
            }
        )*
        wire_types! {
            #[serde(tag = "name", content = "args")]
            pub enum OperationRequest {
                $(#[serde(rename = $name)] $marker($input)),*
            }
            #[serde(tag = "name", content = "data")]
            pub enum OperationResponse {
                $(#[serde(rename = $name)] $marker($output)),*
            }
        }
        pub fn operation_schemas() -> Vec<OperationSchemas> {
            vec![$(schemas::<$marker>()),*]
        }
    };
}

operations! {
    DiscoverOperations: "discover_operations" (EmptyOperationArgs) => OperationCatalogue,
    Configuration: "config" (ConfigArgs) => ConfigResult,
    CheckConfiguration: "config_check" (EmptyOperationArgs) => ConfigCheckResult,
    ConfigurationSchema: "config_schema" (EmptyOperationArgs) => ConfigSchemaResult,
    ReloadConfiguration: "config_reload" (ConfigReloadArgs) => ConfigReloadResult,
    ToolAccessListing: "tools" (EmptyOperationArgs) => ToolAccessResult,
    ListProviders: "list_providers" (EmptyOperationArgs) => ProviderListing,
    ListProviderModels: "list_provider_models" (ProviderModelsArgs) => ProviderModelListing,
    RefreshProviderModels: "refresh_provider_models" (ProviderArgs) => ProviderRefreshed,
    RefreshAllProviderModels: "refresh_all_provider_models" (EmptyOperationArgs) => ProvidersRefreshed,
    ConversationLog: "log" (ConversationLogArgs) => ConversationPage,
    HistoryPage: "history_page" (HistoryPageArgs) => ConversationPage,
    GetMessage: "get" (GetMessageArgs) => Message,
    EditMessage: "edit" (EditMessageArgs) => MessageEdited,
    DeleteMessages: "delete" (DeleteMessagesArgs) => MessagesDeleted,
    ListAlternatives: "list_alternatives" (ListAlternativesArgs) => AlternativeListing,
    SelectAlternative: "alt" (SelectAlternativeArgs) => AlternativeSelected,
    InjectSystem: "inject_system" (InjectSystemArgs) => SystemInjected,
    ListCharacters: "list_characters" (EmptyOperationArgs) => CharacterListing,
    CreateCharacter: "create_character" (NamedOperationArgs) => CharacterCreated,
    SwitchCharacter: "switch_character" (NamedOperationArgs) => CharacterSelection,
    InspectCharacter: "character_info" (CharacterInfoArgs) => CharacterDetails,
    ListThreads: "list_threads" (EmptyOperationArgs) => ThreadListing,
    SwitchThread: "switch_thread" (SwitchThreadArgs) => ThreadSelection,
    CreateThread: "create_thread" (CreateThreadArgs) => ThreadListing,
    ArchiveThread: "archive_thread" (NamedOperationArgs) => ThreadListing,
    ForkThread: "fork_thread" (ForkThreadArgs) => ThreadForkResult,
    SetHomeThread: "thread_home" (NamedOperationArgs) => ThreadListing,
    LabelThread: "thread_label" (ThreadLabelArgs) => ThreadListing,
    PinThreadModel: "thread_model" (ThreadModelArgs) => ThreadListing,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_results_require_matching_outcomes_and_present_nullable_fields() {
        let success = serde_json::json!({"provider":"fixture","ok":true,"model_count":2,"fetched_at":"now","cache_path":"/cache/models.json","future":"inspectable"});
        let failure = serde_json::json!({"provider":"broken","ok":false,"error":"Unavailable"});
        for result in [&success, &failure] {
            assert!(serde_json::from_value::<ProviderRefreshResult>(result.clone()).is_ok());
        }
        let mut invalid_success = success;
        *invalid_success.get_mut("ok").unwrap() = serde_json::json!(false);
        let mut invalid_failure = failure;
        *invalid_failure.get_mut("ok").unwrap() = serde_json::json!(true);
        for result in [invalid_success, invalid_failure] {
            assert!(serde_json::from_value::<ProviderRefreshResult>(result).is_err());
        }
        assert!(
            serde_json::from_value::<ProviderModelCache>(
                serde_json::json!({"fetched_at":null,"model_count":0})
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<ProviderModelCache>(serde_json::json!({"model_count":0}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<ProviderModelsArgs>(
                serde_json::json!({"provider":"fixture","include_hidden":null})
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<ProviderModelsArgs>(
                serde_json::json!({"provider":"fixture","include_hidden":"true"})
            )
            .is_err()
        );
    }

    #[test]
    fn conversation_inputs_distinguish_omitted_and_explicit_null_filters() {
        assert!(
            serde_json::from_value::<ConversationLogArgs>(
                serde_json::json!({"turns":0,"count":null})
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<ConversationLogArgs>(serde_json::json!({"role":null}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<GetMessageArgs>(serde_json::json!({"ref":"last","role":null}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<HistoryPageArgs>(
                serde_json::json!({"before":"active","role":"assistant"})
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<HistoryPageArgs>(serde_json::json!({"before":null})).is_err()
        );
        assert!(
            serde_json::from_value::<ConversationLogArgs>(serde_json::json!({"before":1})).is_err()
        );
        assert!(
            serde_json::from_value::<HistoryPageArgs>(serde_json::json!({"before":-1})).is_err()
        );
        assert!(
            serde_json::from_value::<SelectAlternativeArgs>(
                serde_json::json!({"index":null,"position":2,"direction":"previous"})
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<SelectAlternativeArgs>(
                serde_json::json!({"direction":"backwards"})
            )
            .is_err()
        );
    }

    #[test]
    fn export_operation_schemas() {
        let directory =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../daemon/src/operations");
        std::fs::create_dir_all(&directory).expect("create schema directory");
        let text = serde_json::to_string_pretty(&operation_schemas())
            .expect("serialize operation schemas");
        std::fs::write(
            directory.join("schemas.generated.json"),
            format!("{text}\n"),
        )
        .expect("write schemas");
    }

    #[test]
    fn typed_fork_preserves_legacy_wire_fields_and_request_correlation() {
        let command = ForkThread::command(
            ForkThreadArgs {
                name: "branch".to_owned(),
                from: Some("source".to_owned()),
                turns: Some(3),
            },
            Some("fork-1".to_owned()),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(command).unwrap(),
            serde_json::json!({
                "name": "fork_thread", "rid": "fork-1", "args": {"name": "branch", "from": "source", "turns": 3}
            })
        );
    }

    #[test]
    fn fork_input_accepts_null_optionals_and_rejects_unknown_fields() {
        let input: ForkThreadArgs = serde_json::from_value(
            serde_json::json!({"name": "branch", "from": null, "turns": null}),
        )
        .unwrap();
        assert!(input.from.is_none());
        assert!(input.turns.is_none());
        assert!(
            serde_json::from_value::<ForkThreadArgs>(
                serde_json::json!({"name": "branch", "typo": 3})
            )
            .is_err()
        );
    }

    #[test]
    fn fork_output_uses_the_existing_flat_listing() {
        let value = serde_json::json!({
            "character": "ada", "threads": [], "home": "main", "current": "main",
            "fork": {"fork_id": "f_1", "thread": "branch", "source": "main", "created_at": "now", "messages": 2, "turns": 1, "scope": "last_turns", "requested_turns": 1}
        });
        let output: <ForkThread as Operation>::Output =
            serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(output).unwrap(), value);
    }
}
