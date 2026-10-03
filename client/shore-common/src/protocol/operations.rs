use schemars::{JsonSchema, Schema, generate::SchemaSettings};
use serde::{Deserialize, Serialize};

use super::client_msg::Command;
use super::types::{CharacterInfo, ImageRef, Message, Role, TokenCounts};

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

#[derive(Debug, Clone)]
pub struct PayloadVersion<const VERSION: u32>;

impl<const VERSION: u32> Serialize for PayloadVersion<VERSION> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u32(VERSION)
    }
}

impl<'de, const VERSION: u32> Deserialize<'de> for PayloadVersion<VERSION> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if u32::deserialize(deserializer)? == VERSION {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("unsupported payload version"))
        }
    }
}

impl<const VERSION: u32> JsonSchema for PayloadVersion<VERSION> {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        format!("PayloadVersion{VERSION}").into()
    }

    fn json_schema(_generator: &mut schemars::SchemaGenerator) -> Schema {
        schemars::json_schema!({ "type": "integer", "const": VERSION })
    }
}

wire_types! {
    pub enum OperationCategory { Application, Characters, Threads, Conversation, Providers, Configuration, Models, Diagnostics, Memory, Tools, Usage }

    #[serde(rename_all = "snake_case")]
    pub enum OperationScope { Global, Selection, Character, OptionalCharacter }

    #[serde(rename_all = "snake_case")]
    pub enum OperationPrerequisite { Threads, Autonomy, Keepalive, SessionActivation, Compaction, ToolExecution, Ledger, Archive }

    #[serde(rename_all = "snake_case")]
    pub enum OperationEffect { Read, WorkspaceWrite, HistoryWrite, Selection, ModelSelection, ProviderDiscovery, ConfigWrite, RuntimeWrite, ProviderCall }

    #[serde(rename_all = "snake_case")]
    pub enum OperationConfirmation { None, Archive, Delete, Execute }

    #[serde(rename_all = "snake_case")]
    pub enum OperationChoices { Characters, Threads, Models, Providers, ConfigKeys, Subagents, ModelSettings, Tools }

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

    #[serde(untagged)]
    pub enum OperationScalar { Boolean(bool), Text(String), Number(f64), Null(()) }

    #[serde(tag = "kind", rename_all = "snake_case")]
    pub enum OperationCondition {
        Equals { field: String, value: OperationScalar },
        Absent { field: String },
    }

    pub struct OperationPolicy {
        pub condition: OperationCondition,
        pub effects: Vec<OperationEffect>,
        pub confirmation: OperationConfirmation,
    }

    pub struct OperationDescriptor {
        pub name: String,
        pub label: String,
        pub category: OperationCategory,
        pub scope: OperationScope,
        pub prerequisites: Vec<OperationPrerequisite>,
        pub effects: Vec<OperationEffect>,
        pub confirmation: OperationConfirmation,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub policies: Option<Vec<OperationPolicy>>,
        pub fields: std::collections::BTreeMap<String, OperationField>,
        #[ts(type = "unknown")]
        pub input: serde_json::Value,
        #[ts(type = "unknown")]
        pub output: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub available: Option<bool>,
    }

    pub struct OperationCatalogue {
        pub operations: Vec<OperationDescriptor>,
        #[serde(default)]
        pub requests: Vec<OperationDescriptor>,
    }

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

    #[serde(deny_unknown_fields)]
    pub struct ExportCharacterArgs {
        pub character: String,
        pub output: String,
    }

    #[serde(deny_unknown_fields)]
    pub struct ImportCharacterArgs {
        pub archive: String,
    }

    #[serde(deny_unknown_fields)]
    pub struct DeleteCharacterArgs {
        pub character: String,
        pub confirm: String,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        #[ts(optional)]
        pub archive: Option<String>,
    }

    pub struct ExportCharacterResult {
        pub character: String,
        pub archive: String,
        pub bytes: usize,
        pub live: bool,
        pub call_diagnostics: String,
        pub external_memory: String,
    }

    pub struct ImportCharacterResult {
        pub character: String,
        pub archive: String,
        pub imported: bool,
        pub external_memory: String,
    }

    pub struct DeleteCharacterResult {
        pub character: String,
        pub deleted: bool,
        pub removed: Vec<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub archive: Option<String>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum UsageDimension { Model, Provider, CallType, Kind, ApiKey, CostSource }

    #[serde(rename_all = "snake_case")]
    pub enum UsageBudgetPeriod { Hour, Day, Week, Month }

    #[serde(rename_all = "snake_case")]
    pub enum UsageBudgetAction { Warn, Block, PauseBackground, PauseHeartbeat }

    #[serde(rename_all = "snake_case")]
    pub enum UsageBudgetLevel { Ok, Warning, OverLimit }

    #[serde(rename_all = "snake_case")]
    pub enum UsageCacheState { Cold, Warm }

    #[serde(rename_all = "snake_case")]
    pub enum NanoGptAccountState { Active, Grace, Inactive }

    #[serde(rename_all = "snake_case")]
    pub enum ClaudePlanWindow { FiveHour, SevenDay }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct UsageArgs {
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub last: Option<Option<String>>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub character: Option<Option<String>>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub provider: Option<Option<String>>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub api_key: Option<Option<String>>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub model: Option<Option<String>>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub call_type: Option<Option<String>>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub group_by: Option<Option<UsageDimension>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub budget: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub anomalies: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub export_csv: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub export_tsv: Option<bool>,
    }

    pub struct UsageTotals {
        pub call_count: usize,
        pub total_input: usize,
        pub total_output: usize,
        pub total_cache_read: usize,
        pub total_cache_write: usize,
        pub total_cost: f64,
    }

    pub struct UsageSummaryRow {
        pub provider: String,
        pub model: String,
        #[serde(flatten)]
        pub totals: UsageTotals,
    }

    pub struct GroupedUsageRow {
        pub group: String,
        #[serde(flatten)]
        pub totals: UsageTotals,
    }

    pub struct UsageCostSource {
        pub cost_source: String,
        pub calls: usize,
        pub unpriced_calls: usize,
        pub total_cost: f64,
    }

    pub struct UsageAnomalyCount {
        pub anomaly: String,
        pub calls: usize,
        pub cache_write_tokens: usize,
    }

    pub struct UsageCacheCoverage {
        pub state: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub reason: Option<String>,
        pub calls: usize,
        pub cache_read_tokens: usize,
        pub cache_write_tokens: usize,
    }

    pub struct UsageCacheHealth {
        pub character: String,
        pub state: UsageCacheState,
        pub streak: usize,
    }

    pub struct UsageCallAttempts {
        pub pending: usize,
        pub unresolved: usize,
        pub estimated_cost_at_risk: f64,
    }

    pub struct UsageAnomaly {
        pub ts: String,
        pub character: String,
        pub model: String,
        pub call_type: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub anomaly: Option<String>,
        pub cache_read_tokens: usize,
        pub cache_write_tokens: usize,
    }

    pub struct UsageBudgetFilters {
        #[serde(deserialize_with = "deserialize_nullable")]
        pub character: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub provider: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub api_key: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub model: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub call_type: Option<String>,
        pub usage_kind: Vec<String>,
    }

    pub struct UsagePace {
        pub period: UsageBudgetPeriod,
        pub window_start: String,
        pub window_end: String,
        pub allowance: f64,
        pub base_allowance: f64,
        pub rollover: f64,
        pub debt_adjustment: f64,
        pub current_cost: f64,
        pub remaining: f64,
        pub percent_used: f64,
        pub periods_remaining: usize,
        pub status: UsageBudgetLevel,
        pub action: UsageBudgetAction,
        pub effective_action: UsageBudgetAction,
        pub warning_thresholds: Vec<f64>,
        pub crossed_warn_at: Vec<f64>,
        pub over_limit: bool,
    }

    pub struct UsageBudget {
        pub name: String,
        pub period: UsageBudgetPeriod,
        pub period_start: String,
        pub period_end: String,
        pub reset_at: String,
        pub timezone: String,
        pub current_cost: f64,
        pub cost_limit: f64,
        pub percent_used: f64,
        pub status: UsageBudgetLevel,
        pub action: UsageBudgetAction,
        pub effective_action: UsageBudgetAction,
        pub warning_thresholds: Vec<f64>,
        pub crossed_warn_at: Vec<f64>,
        pub over_limit: bool,
        pub compaction_allowed_over_budget: bool,
        pub filters: UsageBudgetFilters,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "UsagePace")]
        #[ts(optional)]
        pub pace: Option<UsagePace>,
    }

    pub struct RateLimitSnapshot {
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "f64")]
        #[ts(optional)]
        pub requests_remaining: Option<f64>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "f64")]
        #[ts(optional)]
        pub requests_limit: Option<f64>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "f64")]
        #[ts(optional)]
        pub input_tokens_remaining: Option<f64>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "f64")]
        #[ts(optional)]
        pub input_tokens_limit: Option<f64>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "f64")]
        #[ts(optional)]
        pub output_tokens_remaining: Option<f64>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "f64")]
        #[ts(optional)]
        pub output_tokens_limit: Option<f64>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        #[ts(optional)]
        pub resets_at: Option<String>,
    }

    pub struct UsageRateLimitReading {
        pub host: String,
        pub observed_at: String,
        #[serde(flatten)]
        pub limits: RateLimitSnapshot,
    }

    #[serde(rename_all = "camelCase")]
    pub struct NanoGptWeeklyInputTokens {
        pub used: f64,
        pub remaining: f64,
        pub limit: f64,
        pub reset_at: String,
    }

    pub struct NanoGptRouting {
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        #[ts(optional)]
        #[serde(rename = "recommendedMode")]
        pub recommended_mode: Option<String>,
    }

    pub struct NanoGptSubscriptionState {
        #[ts(type = "1")]
        pub version: PayloadVersion<1>,
        pub fetched_at: String,
        pub active: bool,
        pub state: NanoGptAccountState,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "NanoGptWeeklyInputTokens")]
        #[ts(optional)]
        #[serde(rename = "weeklyInputTokens")]
        pub weekly_input_tokens: Option<NanoGptWeeklyInputTokens>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "NanoGptRouting")]
        #[ts(optional)]
        pub routing: Option<NanoGptRouting>,
    }

    pub struct ClaudePlanLimit {
        pub window: ClaudePlanWindow,
        pub percent_used: f64,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub resets_at: Option<String>,
        pub status: UsageBudgetLevel,
        pub warning_thresholds: Vec<f64>,
        pub crossed_warn_at: Vec<f64>,
        pub limit_at: f64,
        pub action: UsageBudgetAction,
        pub over_limit: bool,
    }

    pub struct ClaudePlanLimitsReport {
        pub updated_at: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub subscription_type: Option<String>,
        pub windows: Vec<ClaudePlanLimit>,
    }

    pub struct UsageSummaryReport {
        pub period: String,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        #[ts(optional)]
        pub period_since: Option<String>,
        pub timezone: String,
        pub summary: Vec<UsageSummaryRow>,
        pub cache_health: Vec<UsageCacheHealth>,
        pub anomaly_count_7d: usize,
        pub anomaly_counts_7d: Vec<UsageAnomalyCount>,
        pub cache_coverage: Vec<UsageCacheCoverage>,
        pub cost_sources: Vec<UsageCostSource>,
        pub rate_limits: Vec<UsageRateLimitReading>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub nanogpt_subscription: Option<NanoGptSubscriptionState>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub claude_plan_limits: Option<ClaudePlanLimitsReport>,
        pub call_attempts: UsageCallAttempts,
        pub budgets: Vec<UsageBudget>,
    }

    pub struct UsageGroupedReport {
        pub dimension: UsageDimension,
        pub period: String,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "String")]
        #[ts(optional)]
        pub period_since: Option<String>,
        pub summary: Vec<GroupedUsageRow>,
    }

    pub struct UsageBudgetReport {
        pub timezone: String,
        pub budgets: Vec<UsageBudget>,
        pub call_attempts: UsageCallAttempts,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[schemars(with = "ClaudePlanLimitsReport")]
        #[ts(optional)]
        pub claude_plan_limits: Option<ClaudePlanLimitsReport>,
    }

    pub struct UsageAnomaliesReport {
        pub anomalies: Vec<UsageAnomaly>,
    }

    pub struct UsageExportReport {
        pub data: String,
    }

    #[serde(tag = "mode", rename_all = "snake_case")]
    pub enum UsageResult {
        Summary(Box<UsageSummaryReport>),
        SummaryBy(UsageGroupedReport),
        Budget(UsageBudgetReport),
        Anomalies(UsageAnomaliesReport),
        Csv(UsageExportReport),
        Tsv(UsageExportReport),
    }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct RunToolArgs {
        #[schemars(length(min = 1))]
        pub tool: String,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_present")]
        #[schemars(with = "std::collections::BTreeMap<String, serde_json::Value>")]
        #[ts(optional, type = "{ [key: string]: unknown }")]
        pub input: Option<std::collections::BTreeMap<String, serde_json::Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_present")]
        #[schemars(with = "std::collections::BTreeMap<String, String>")]
        #[ts(optional)]
        pub pairs: Option<std::collections::BTreeMap<String, String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub raw: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub describe: Option<bool>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum ToolKind { Builtin, Subagent, Mcp }

    #[serde(rename_all = "snake_case")]
    pub enum ToolDescriptionMode { ToolDefinition }

    pub struct ToolDescription {
        pub mode: ToolDescriptionMode,
        pub tool: String,
        pub kind: ToolKind,
        pub enabled: bool,
        pub description: String,
        #[ts(type = "{ [key: string]: unknown }")]
        pub input_schema: std::collections::BTreeMap<String, serde_json::Value>,
    }

    pub struct NestedToolCall {
        pub tool: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub subagent: Option<String>,
        pub ok: bool,
        pub input: String,
        pub output: String,
    }

    pub struct ToolRunReport {
        pub tool: String,
        pub character: String,
        pub kind: ToolKind,
        pub enabled: bool,
        #[ts(type = "{ [key: string]: unknown }")]
        pub input: std::collections::BTreeMap<String, serde_json::Value>,
        pub ok: bool,
        pub rejected: bool,
        #[schemars(range(min = 0.0))]
        pub duration_ms: f64,
        pub output: String,
        pub truncated: bool,
        pub result_chars: usize,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub raw: Option<String>,
        pub calls: Vec<NestedToolCall>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[ts(as = "Option<Vec<ImageRef>>", optional)]
        pub images: Vec<ImageRef>,
    }

    #[serde(untagged)]
    pub enum RunToolResult { Description(ToolDescription), Execution(ToolRunReport) }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct CompactArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub dry_run: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub restart: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        #[schemars(range(max = 9007199254740991_u64))]
        pub keep_turns: Option<u64>,
    }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct ClearArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub exclude: Option<bool>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub note: Option<Option<String>>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum SegmentAction { List, Show, Exclude, Include, Label, Note }

    #[serde(rename_all = "snake_case")]
    pub enum SegmentMutation { Exclude, Include, Label, Note }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct SegmentsArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub action: Option<SegmentAction>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        #[schemars(range(max = 9007199254740991_u64))]
        pub index: Option<u64>,
        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub value: Option<Option<String>>,
    }

    pub struct SegmentSummary {
        #[ts(type = "number")]
        pub index: u64,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub first_message_at: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub last_message_at: Option<String>,
        pub compacted_at: String,
        pub message_count: usize,
        pub excluded: bool,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub label: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub note: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub memory_before: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub memory_after: Option<String>,
    }

    pub struct SegmentsListing {
        pub character: String,
        pub thread: String,
        pub segments: Vec<SegmentSummary>,
        pub count: usize,
    }

    pub struct SegmentInspection {
        pub character: String,
        pub thread: String,
        pub segment: SegmentSummary,
        pub messages: Vec<Message>,
    }

    pub struct SegmentChanged {
        pub character: String,
        pub thread: String,
        pub action: SegmentMutation,
        pub segment: SegmentSummary,
    }

    #[serde(untagged)]
    pub enum SegmentsResult { Listing(SegmentsListing), Inspection(Box<SegmentInspection>), Changed(Box<SegmentChanged>) }

    #[serde(tag = "status", rename_all = "snake_case")]
    pub enum ClearResult {
        Clear {
            character: String,
            thread: String,
            message_count: usize,
            #[serde(deserialize_with = "deserialize_nullable")]
            segment: Option<SegmentSummary>,
        },
    }

    pub struct CompactionPreviewFile {
        pub path: String,
        pub content_preview: String,
    }

    #[serde(tag = "status", rename_all = "snake_case")]
    pub enum CompactionReport {
        Compacted {
            character: String,
            message_count: usize,
            turn_count: usize,
            compacted_turns: usize,
            retained_count: usize,
            retained_turns: usize,
            memory_files_written: Vec<String>,
            new_conversation_id: String,
            tool_rounds: usize,
            tools_called: Vec<String>,
        },
        Rotated {
            character: String,
            message_count: usize,
            turn_count: usize,
            compacted_turns: usize,
            retained_count: usize,
            retained_turns: usize,
            dry_run: bool,
            memory_files_written: Vec<String>,
            archived_messages: usize,
        },
        DryRun {
            character: String,
            message_count: usize,
            turn_count: usize,
            compacted_turns: usize,
            retained_count: usize,
            retained_turns: usize,
            would_write_files: usize,
            file_ops_preview: Vec<CompactionPreviewFile>,
            tool_rounds: usize,
            tools_called: Vec<String>,
        },
        Truncated {
            character: String,
            message_count: usize,
            turn_count: usize,
            compacted_turns: usize,
            tool_rounds: usize,
            tools_called: Vec<String>,
            truncated_turns: usize,
            partial_writes: Vec<String>,
        },
        Paused {
            character: String,
            message_count: usize,
            compacted_turns: usize,
            checkpoint_id: String,
            tool_rounds: usize,
            tools_called: Vec<String>,
            reason: String,
            #[serde(deserialize_with = "deserialize_nullable")]
            detail: Option<String>,
            #[serde(deserialize_with = "deserialize_nullable")]
            resume_at: Option<String>,
        },
    }

    #[serde(rename_all = "snake_case")]
    pub enum CompactionTrigger { Manual, Idle, Turn, DeepArchive }

    pub struct CompactionPassEnd {
        pub thread: String,
        pub trigger: CompactionTrigger,
        pub started_at: String,
        pub ended_at: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub report: Option<CompactionReport>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub error: Option<String>,
    }

    pub struct CompactionPassProgress {
        pub thread: String,
        pub trigger: CompactionTrigger,
        pub started_at: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub phase: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub last_tool: Option<String>,
    }

    pub struct CompactionCheckpointStatus {
        pub thread: String,
        pub checkpoint_id: String,
        pub reason: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub detail: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub resume_at: Option<String>,
        pub tool_rounds: usize,
        pub compacted_turns: usize,
        pub updated_at: String,
    }

    pub struct CompactionStatusReport {
        #[serde(deserialize_with = "deserialize_nullable")]
        pub running: Option<CompactionPassProgress>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub paused: Option<CompactionCheckpointStatus>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub last: Option<CompactionPassEnd>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum CompactionWatchState { Finished, Cancelled, Idle }

    pub struct CompactionWatchResult {
        pub character: String,
        pub state: CompactionWatchState,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub pass: Option<CompactionPassEnd>,
    }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct DiagnosticCountArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub count: Option<u32>,
    }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct CallLogArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        #[schemars(range(min = -9007199254740991_i64, max = 9007199254740991_i64))]
        pub id: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub count: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub call_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub character: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub diff: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        #[schemars(range(min = -9007199254740991_i64, max = 9007199254740991_i64))]
        pub against: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub wire: Option<bool>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum TranscriptSource { Heartbeat }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct TranscriptArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub source: Option<TranscriptSource>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub count: Option<u32>,
    }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct SubagentTraceArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub ids: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub count: Option<u32>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum HeartbeatEventKind { TickFired, CallFailed, MessageSent, MessageSkipped, ToolUse, Dormant, Wake, Timeout, DormantPing, BudgetPaused, RecapWritten, RecapMissing }

    pub struct HeartbeatEvent {
        pub timestamp: String,
        pub kind: HeartbeatEventKind,
        pub detail: String,
    }

    pub struct HeartbeatLogResult {
        pub events: Vec<HeartbeatEvent>,
    }

    pub struct DiagnosticErrorEntry {
        pub timestamp: String,
        pub error_type: String,
        pub message: String,
        pub context: String,
    }

    pub struct DiagnosticKeyFallbackEntry {
        pub timestamp: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub rid: Option<String>,
        pub provider: String,
        pub model: String,
        pub character: String,
        pub from_key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub to_key: Option<String>,
        pub kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub status: Option<u32>,
        pub reason: String,
    }

    pub struct DiagnosticErrorRing {
        pub count: usize,
        pub recent: Vec<DiagnosticErrorEntry>,
    }

    pub struct DiagnosticKeyFallbackRing {
        pub count: usize,
        pub recent: Vec<DiagnosticKeyFallbackEntry>,
    }

    pub struct ErrorLogResult {
        pub errors: DiagnosticErrorRing,
        pub key_fallbacks: DiagnosticKeyFallbackRing,
    }

    pub enum AutonomyHeartbeatState { Active, Dormant }

    #[serde(rename_all = "snake_case")]
    pub enum ActivityHourClass { Peak, Trough, Normal }

    pub struct AutonomyStatusReport {
        pub heartbeat_state: AutonomyHeartbeatState,
        #[ts(type = "number")]
        pub ticks_without_user: u64,
        #[ts(type = "number")]
        pub dormant_after_heartbeat_turns: u64,
        #[ts(type = "number")]
        pub default_interval_secs: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub next_wake_at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[ts(type = "number")]
        pub seconds_until_wake: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub last_user_at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[ts(type = "number")]
        pub seconds_since_user: Option<u64>,
        #[ts(type = "number")]
        pub min_interval_secs: u64,
        #[ts(type = "number")]
        pub max_interval_secs: u64,
        #[ts(type = "number")]
        pub dormant_after_idle_time_secs: u64,
        pub recent_events: Vec<HeartbeatEvent>,
    }

    pub struct ActivityStatusReport {
        pub hour_histogram: Vec<f64>,
        pub hour_classifications: Vec<ActivityHourClass>,
        pub has_sufficient_heatmap: bool,
        pub engagement_score: f64,
        pub sessions_per_day: f64,
        #[ts(type = "number")]
        pub message_count: u64,
        #[ts(type = "number")]
        pub turn_count: u64,
    }

    pub struct DiagnosticIndexError {
        pub error: String,
    }

    pub struct IndexBackgroundStatus {
        pub registered: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub swept: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub embedder_error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub failures: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub last_error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[ts(type = "number")]
        pub retry_in_secs: Option<u64>,
    }

    pub struct WorkspaceIndexStatus {
        pub path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub unusable: Option<String>,
        pub files: usize,
        pub embedded: usize,
        pub pending: usize,
        pub skipped: usize,
        pub skip_reasons: std::collections::BTreeMap<String, usize>,
        pub vectors: usize,
        pub models: Vec<String>,
        #[ts(type = "number")]
        pub bytes: u64,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub last_indexed_at: Option<String>,
        pub background: IndexBackgroundStatus,
    }

    pub struct HistoryIndexStatus {
        pub path: String,
        pub messages: usize,
        pub chunks: usize,
        pub embedded: usize,
        pub pending: usize,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub model: Option<String>,
        pub background: IndexBackgroundStatus,
    }

    #[serde(untagged)]
    pub enum WorkspaceIndexResult { Error(DiagnosticIndexError), Status(Box<WorkspaceIndexStatus>) }

    #[serde(untagged)]
    pub enum HistoryIndexResult { Error(DiagnosticIndexError), Status(HistoryIndexStatus) }

    #[serde(rename_all = "snake_case")]
    pub enum McpConnectionState { Connected, Unavailable, Retrying, Invalid }

    #[serde(rename_all = "snake_case")]
    pub enum McpTransportKind { Stdio, Http }

    pub struct McpStatusEntry {
        pub name: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub transport: Option<McpTransportKind>,
        pub state: McpConnectionState,
        pub connected_tools: usize,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub last_error: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub next_retry_at: Option<String>,
    }

    pub struct McpStatusReport {
        pub configured: usize,
        pub connected: usize,
        pub unavailable: usize,
        pub servers: Vec<McpStatusEntry>,
    }

    pub struct KeepaliveHaltReport {
        pub character: String,
        pub model: String,
        pub reason: String,
        pub at: String,
    }

    pub struct DiagnosticUsage {
        #[ts(type = "number")]
        pub input_tokens: u64,
        #[ts(type = "number")]
        pub output_tokens: u64,
        #[ts(type = "number")]
        pub cache_read_tokens: u64,
        #[ts(type = "number")]
        pub cache_write_tokens: u64,
    }

    pub struct StatusReport {
        pub character: String,
        pub keepalive_halts: Vec<KeepaliveHaltReport>,
        pub message_count: usize,
        pub turn_count: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[ts(type = "number")]
        pub context_tokens: Option<u64>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub active_model: Option<String>,
        pub config_dir: String,
        pub data_dir: String,
        pub cache_dir: String,
        pub pending_deferred_edit_count: usize,
        pub pending_deferred_edits: Vec<String>,
        pub tokens: TokenCounts,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub autonomy: Option<AutonomyStatusReport>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub activity: Option<ActivityStatusReport>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub index: Option<WorkspaceIndexResult>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub history_index: Option<HistoryIndexResult>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub mcp: Option<McpStatusReport>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub compaction: Option<CompactionStatusReport>,
        pub sections: Vec<String>,
    }

    pub struct CallSummary {
        #[ts(type = "number")]
        pub id: i64,
        pub call_id: String,
        pub ts: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub call_type: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub character: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub model: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub provider: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub finish_reason: Option<String>,
        pub usage: DiagnosticUsage,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub duration_ms: Option<f64>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub error: Option<String>,
        #[ts(type = "number")]
        pub request_bytes: u64,
        #[ts(type = "number")]
        pub response_bytes: u64,
    }

    pub struct CallDetail {
        #[serde(flatten)]
        pub summary: CallSummary,
        #[ts(type = "unknown")]
        pub request: serde_json::Value,
        #[ts(type = "unknown")]
        pub response: serde_json::Value,
    }

    pub struct HttpExchange {
        #[ts(type = "number")]
        pub id: i64,
        pub call_id: String,
        pub seq: usize,
        pub ts: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub character: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub call_type: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub rid: Option<String>,
        pub method: String,
        pub url: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub status: Option<u32>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub status_text: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub duration_ms: Option<f64>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub error: Option<String>,
        #[ts(type = "number")]
        pub request_bytes: u64,
        #[ts(type = "number")]
        pub response_bytes: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub request_headers: Option<Vec<(String, String)>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub response_headers: Option<Vec<(String, String)>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[ts(type = "unknown")]
        pub request_body: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[ts(type = "unknown")]
        pub response_body: Option<serde_json::Value>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum PayloadDiffOperation { Equal, Added, Removed }

    #[serde(rename_all = "snake_case")]
    pub enum CallDiffSource { Wire, Internal }

    pub struct PayloadDiffCounts {
        #[ts(type = "number")]
        pub equal: u64,
        #[ts(type = "number")]
        pub added: u64,
        #[ts(type = "number")]
        pub removed: u64,
    }

    pub struct PayloadDiffEntry {
        pub op: PayloadDiffOperation,
        pub hash: String,
        #[ts(type = "number")]
        pub bytes: u64,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub text: Option<String>,
    }

    pub struct CallDiff {
        #[ts(type = "number")]
        pub from_payload: i64,
        #[ts(type = "number")]
        pub to_payload: i64,
        #[ts(type = "number")]
        pub from_call: i64,
        #[ts(type = "number")]
        pub to_call: i64,
        pub source: CallDiffSource,
        pub chunks: PayloadDiffCounts,
        pub bytes: PayloadDiffCounts,
        pub entries: Vec<PayloadDiffEntry>,
    }

    pub struct CallListing {
        pub enabled: bool,
        pub entries: Vec<CallSummary>,
    }

    pub struct CallInspection {
        pub enabled: bool,
        pub call: CallDetail,
        pub wire: Vec<HttpExchange>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub diff: Option<CallDiff>,
    }

    #[serde(untagged)]
    pub enum CallLogResult { Listing(CallListing), Inspection(Box<CallInspection>) }

    pub struct TranscriptToolCall {
        pub name: String,
        #[ts(type = "unknown")]
        pub input: serde_json::Value,
        pub output: String,
        pub is_error: bool,
    }

    pub struct HeartbeatTranscriptEntry {
        pub reasoning: Vec<String>,
        pub text: String,
        pub tool_calls: Vec<TranscriptToolCall>,
    }

    pub struct TranscriptRow {
        #[ts(type = "number")]
        pub id: i64,
        pub ts: String,
        pub source: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub character: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub call_type: Option<String>,
        pub iteration: usize,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub model: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub provider: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub finish_reason: Option<String>,
        pub usage: DiagnosticUsage,
        #[ts(type = "unknown")]
        pub entry: serde_json::Value,
    }

    pub struct TranscriptResult {
        pub enabled: bool,
        pub source: TranscriptSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub character: Option<String>,
        pub entries: Vec<TranscriptRow>,
    }

    pub struct StoredSubagentTrace {
        pub ts: String,
        pub subagent: String,
        pub parent_tool_use_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub rid: Option<String>,
        pub model: String,
        pub messages: Vec<Message>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub messages_expired: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub result: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub error: Option<String>,
    }

    pub struct SubagentTraceResult {
        pub character: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub requested_ids: Option<Vec<String>>,
        pub entries: Vec<StoredSubagentTrace>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum HeartbeatControlStatus { Scheduled, Dormant, Active }

    pub struct HeartbeatControlResult {
        pub status: HeartbeatControlStatus,
        pub character: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub warning: Option<String>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum KeepaliveRequestSource { CachedLastRequest, RebuiltFromDisk }

    pub struct KeepalivePingDetail {
        pub character: String,
        pub source: KeepaliveRequestSource,
        #[ts(type = "number")]
        pub input_tokens: u64,
        #[ts(type = "number")]
        pub cache_read_tokens: u64,
        #[ts(type = "number")]
        pub cache_creation_tokens: u64,
        pub note: String,
    }

    pub struct KeepalivePingSkipped {
        pub character: String,
        pub reason: String,
    }

    #[serde(tag = "status", rename_all = "snake_case")]
    pub enum KeepalivePingResult { Skipped(KeepalivePingSkipped), Warm(KeepalivePingDetail), Cold(KeepalivePingDetail) }

    pub struct ScheduledKeepalivePing {
        #[ts(type = "number")]
        pub interval_secs: u64,
        pub next_ping_at: String,
        #[ts(type = "number")]
        pub seconds_until_ping: i64,
    }

    pub struct PrimedKeepalivePing {
        #[serde(flatten)]
        pub schedule: ScheduledKeepalivePing,
        #[ts(type = "number")]
        pub input_tokens: u64,
        #[ts(type = "number")]
        pub cache_read_tokens: u64,
        #[ts(type = "number")]
        pub cache_creation_tokens: u64,
        pub wrote_cache: bool,
    }

    pub struct KeepaliveActivationDetail {
        pub detail: String,
    }

    #[serde(tag = "status", rename_all = "snake_case")]
    pub enum KeepaliveActivation { Unavailable(KeepaliveActivationDetail), Off, Resumed(ScheduledKeepalivePing), Primed(PrimedKeepalivePing), Skipped(KeepaliveActivationDetail), Failed(KeepaliveActivationDetail) }

    pub struct ActivatedHeartbeat {
        pub state: AutonomyHeartbeatState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub next_wake_at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[ts(type = "number")]
        pub seconds_until_wake: Option<i64>,
    }

    pub struct SessionActivated {
        pub character: String,
        pub registered: bool,
        pub keepalive: KeepaliveActivation,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub heartbeat: Option<ActivatedHeartbeat>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum BackgroundModelTarget { All, Heartbeat, Compaction }

    #[serde(rename_all = "snake_case")]
    pub enum ModelPreferenceScope { Character, Global }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct ListModelsArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub include_hidden: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub favorites_only: Option<bool>,
    }

    #[serde(deny_unknown_fields)]
    pub struct FavoriteModelArgs {
        pub name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub favorite: Option<bool>,
    }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct ModelInfoArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub background_task: Option<BackgroundModelTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub subagent: Option<String>,
    }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct SwitchModelArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub background_task: Option<BackgroundModelTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub subagent: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub include_hidden: Option<bool>,
    }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct ResetModelArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub background_task: Option<BackgroundModelTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub subagent: Option<String>,
    }

    #[serde(deny_unknown_fields)]
    #[derive(Default)]
    pub struct ModelSettingsArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub background_task: Option<BackgroundModelTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub subagent: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub overview: Option<bool>,
    }

    #[serde(deny_unknown_fields)]
    pub struct SetModelSettingArgs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub background_task: Option<BackgroundModelTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub subagent: Option<String>,
        pub key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub scope: Option<ModelPreferenceScope>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "unknown")]
        pub value: Option<serde_json::Value>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum ModelSource { Static, Discovered, Favorite }

    pub struct ModelSummary {
        pub name: String,
        pub qualified_name: String,
        pub sdk: String,
        pub model_id: String,
        pub source: ModelSource,
        pub hidden: bool,
        pub favorite: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub subscription_included: Option<bool>,
    }

    pub struct ModelRole {
        pub role: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub model: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub source: Option<String>,
    }

    pub struct ModelListing {
        pub models: std::collections::BTreeMap<String, Vec<ModelSummary>>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub active: Option<String>,
        pub roles: Vec<ModelRole>,
        pub include_hidden: bool,
        pub favorites_only: bool,
        pub favorite_count: usize,
        pub hidden_count: usize,
    }

    pub struct ModelFavorite {
        pub qualified_name: String,
        pub provider: String,
        pub model_id: String,
        pub favorite: bool,
        pub changed: bool,
        pub favorites: Vec<String>,
    }

    #[serde(rename_all = "snake_case")]
    pub enum ModelSettingKind { Number, U32, Boolean, String, Duration, DurationOrOff, JsonObject }

    #[serde(rename_all = "snake_case")]
    pub enum ModelSettingApplicability { Always, Honored, Ignored, Rejected }

    #[serde(tag = "kind", rename_all = "snake_case")]
    pub enum ModelSettingEditor { Slider { min: f64, max: f64, step: f64 } }

    pub struct ModelSettingSchemaEntry {
        pub key: String,
        pub kind: ModelSettingKind,
        pub applicability: ModelSettingApplicability,
        pub suggestions: Vec<String>,
        pub allow_custom: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub editor: Option<ModelSettingEditor>,
    }

    pub struct ModelInfoResult {
        pub name: String,
        pub qualified_name: String,
        pub category: String,
        pub provider_key: String,
        pub sdk: String,
        pub model_id: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub api_key_env: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub base_url: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub max_context_tokens: Option<f64>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub max_output_tokens: Option<f64>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub temperature: Option<f64>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub top_p: Option<f64>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub budget_tokens: Option<f64>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub gemini_generation: Option<f64>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub max_tool_iterations: Option<f64>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub reasoning_effort: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub cache_ttl: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub cache_keepalive: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub cache_keepalive_pings: Option<f64>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub replay_prior_thinking: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub zai_clear_thinking: Option<bool>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub supports_images: Option<bool>,
        #[ts(type = "unknown")]
        pub openrouter_provider: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[ts(type = "Record<string, unknown>")]
        pub effective_sampler: Option<std::collections::BTreeMap<String, serde_json::Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub scopes: Option<std::collections::BTreeMap<String, Option<String>>>,
    }

    pub struct ModelInvalidated {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub cached_request: Option<bool>,
    }

    pub struct ModelActive {
        #[serde(deserialize_with = "deserialize_nullable")]
        pub active: Option<String>,
    }

    pub struct ModelSelected {
        pub active: String,
        pub qualified_name: String,
        pub provider: String,
        pub model_id: String,
        pub changed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub invalidated: Option<ModelInvalidated>,
    }

    pub struct CharacterModelSelected {
        #[serde(flatten)]
        pub selection: ModelSelected,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub shadowed_by_thread: Option<Option<String>>,
    }

    pub struct RoleModelSelected {
        #[serde(flatten)]
        pub selection: ModelSelected,
        pub role: String,
        pub config_key: String,
        pub cleared: Vec<String>,
        pub file: String,
        pub restart_required: Vec<String>,
    }

    #[serde(tag = "target", rename_all = "snake_case")]
    pub enum ModelSwitchResult { Current(ModelActive), Thread(ModelSelected), Character(CharacterModelSelected), Role(RoleModelSelected) }

    pub struct ThreadModelReset {
        #[serde(deserialize_with = "deserialize_nullable")]
        pub active: Option<String>,
        pub reset_to: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub invalidated: Option<ModelInvalidated>,
    }

    pub struct CharacterModelReset {
        #[serde(deserialize_with = "deserialize_nullable")]
        pub active: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub previous_provider: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub previous_model_id: Option<String>,
        pub reset_to: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub invalidated: Option<ModelInvalidated>,
    }

    pub struct RoleModelReset {
        #[serde(deserialize_with = "deserialize_nullable")]
        pub active: Option<String>,
        pub role: String,
        pub cleared: Vec<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub source: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub file: Option<String>,
        pub reset_to: String,
        pub roles: Vec<ModelRole>,
    }

    #[serde(tag = "target", rename_all = "snake_case")]
    pub enum ModelResetResult { Thread(ThreadModelReset), Character(CharacterModelReset), Role(RoleModelReset) }

    pub struct ModelSettingChanged {
        pub changed: bool,
        pub scope: ModelPreferenceScope,
        pub model: String,
        pub provider: String,
        pub model_id: String,
        pub key: String,
        #[ts(type = "unknown")]
        pub value: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub subagent: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub applies_to: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub background_task: Option<BackgroundModelTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub also_affects: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub invalidated: Option<ModelInvalidated>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub warning: Option<String>,
    }

    pub struct SavedModelSetting {
        pub key: String,
        #[ts(type = "unknown")]
        pub value: serde_json::Value,
        pub scope: ModelPreferenceScope,
    }

    pub struct ModelOverviewRole {
        pub role: String,
        pub flag: String,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub model: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub source: Option<String>,
        pub inherited: bool,
        pub settings: Vec<SavedModelSetting>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub same_settings_as: Option<String>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub error: Option<String>,
    }

    pub struct ModelSettingsOverview {
        pub overview: bool,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub character: Option<String>,
        pub roles: Vec<ModelOverviewRole>,
        pub inherited_count: usize,
    }

    pub struct ModelSettingsDetail {
        pub model: String,
        pub provider: String,
        pub model_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub subagent: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub applies_to: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pub key: Option<String>,
        #[ts(type = "Record<string, unknown>")]
        pub effective_sampler: std::collections::BTreeMap<String, serde_json::Value>,
        #[serde(deserialize_with = "deserialize_nullable")]
        #[ts(type = "Record<string, unknown> | null")]
        pub saved_global: Option<std::collections::BTreeMap<String, serde_json::Value>>,
        #[serde(deserialize_with = "deserialize_nullable")]
        #[ts(type = "Record<string, unknown> | null")]
        pub saved_character: Option<std::collections::BTreeMap<String, serde_json::Value>>,
        pub setting_schema: Vec<ModelSettingSchemaEntry>,
        pub scopes: std::collections::BTreeMap<String, Option<String>>,
    }

    #[serde(untagged)]
    pub enum ModelSettingsResult { Overview(ModelSettingsOverview), Detail(Box<ModelSettingsDetail>) }

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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        #[schemars(range(max = 9007199254740991_u64))]
        pub segment: Option<u64>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        #[schemars(range(max = 9007199254740991_u64))]
        pub segment: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(type = "number | null")]
        #[schemars(range(max = 9007199254740991_u64))]
        pub before: Option<u64>,
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
        pub cursor: usize,
        pub next_before: usize,
        pub has_more_before: bool,
        pub total_turns: usize,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub segment: Option<SegmentSummary>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub previous_segment: Option<SegmentSummary>,
        #[serde(deserialize_with = "deserialize_nullable")]
        pub next_segment: Option<SegmentSummary>,
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
                $(#[serde(rename = $name)] $marker(Box<$output>)),*
            }
        }
        pub fn operation_schemas() -> Vec<OperationSchemas> {
            vec![$(schemas::<$marker>()),*]
        }

        pub fn is_registered_operation(name: &str) -> bool {
            matches!(name, $($name)|*)
        }
    };
}

operations! {
    ExportCharacter: "export_character" (ExportCharacterArgs) => ExportCharacterResult,
    ImportCharacter: "import_character" (ImportCharacterArgs) => ImportCharacterResult,
    DeleteCharacter: "delete_character" (DeleteCharacterArgs) => DeleteCharacterResult,
    UsageReport: "usage" (UsageArgs) => UsageResult,
    ExecuteTool: "run_tool" (RunToolArgs) => RunToolResult,
    CompactConversation: "compact" (CompactArgs) => CompactionReport,
    WatchCompaction: "compact_watch" (EmptyOperationArgs) => CompactionWatchResult,
    CancelCompaction: "compact_cancel" (EmptyOperationArgs) => CompactionWatchResult,
    InspectSegments: "segments" (SegmentsArgs) => SegmentsResult,
    ClearConversation: "clear" (ClearArgs) => ClearResult,
    ReadStatus: "status" (EmptyOperationArgs) => StatusReport,
    ReadErrorLog: "error_log" (DiagnosticCountArgs) => ErrorLogResult,
    ReadHeartbeatLog: "heartbeat_log" (DiagnosticCountArgs) => HeartbeatLogResult,
    InspectCalls: "call_log" (CallLogArgs) => CallLogResult,
    ReadTranscript: "transcript" (TranscriptArgs) => TranscriptResult,
    ReadSubagentTraces: "subagent_trace" (SubagentTraceArgs) => SubagentTraceResult,
    ScheduleHeartbeat: "heartbeat_tick_now" (EmptyOperationArgs) => HeartbeatControlResult,
    SetHeartbeatDormant: "heartbeat_set_dormant" (EmptyOperationArgs) => HeartbeatControlResult,
    SetHeartbeatActive: "heartbeat_set_active" (EmptyOperationArgs) => HeartbeatControlResult,
    PingKeepalive: "keepalive_ping_now" (EmptyOperationArgs) => KeepalivePingResult,
    ActivateSession: "session_activate" (EmptyOperationArgs) => SessionActivated,
    DiscoverOperations: "discover_operations" (EmptyOperationArgs) => OperationCatalogue,
    ListModels: "list_models" (ListModelsArgs) => ModelListing,
    FavoriteModel: "favorite_model" (FavoriteModelArgs) => ModelFavorite,
    InspectModel: "model_info" (ModelInfoArgs) => ModelInfoResult,
    SwitchModel: "switch_model" (SwitchModelArgs) => ModelSwitchResult,
    ResetModel: "reset_model" (ResetModelArgs) => ModelResetResult,
    ModelSettings: "model_settings" (ModelSettingsArgs) => ModelSettingsResult,
    SetModelSetting: "set_model_setting" (SetModelSettingArgs) => ModelSettingChanged,
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

    fn recorded_result(section: &str) -> serde_json::Value {
        let recorded: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../daemon/tests/command_captures/operation_results.json"
        ))
        .unwrap();
        recorded.get(section).unwrap().clone()
    }

    fn numbers_as_f64(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Number(number) => number
                .as_f64()
                .map_or(serde_json::Value::Number(number), serde_json::Value::from),
            serde_json::Value::Array(items) => items.into_iter().map(numbers_as_f64).collect(),
            serde_json::Value::Object(fields) => fields
                .into_iter()
                .map(|(key, item)| (key, numbers_as_f64(item)))
                .collect(),
            other @ (serde_json::Value::Null
            | serde_json::Value::Bool(_)
            | serde_json::Value::String(_)) => other,
        }
    }

    #[test]
    fn archive_contracts_preserve_backups_and_require_complete_results() {
        let archives: Vec<serde_json::Value> =
            serde_json::from_value(recorded_result("character_archives")).unwrap();
        for archive in archives {
            let name = archive.get("name").unwrap().as_str().unwrap();
            assert!(
                serde_json::from_value::<OperationRequest>(
                    serde_json::json!({"name":name,"args":archive.get("input").unwrap()})
                )
                .is_ok()
            );
            let result = archive.get("result").unwrap().clone();
            assert!(
                serde_json::from_value::<OperationResponse>(
                    serde_json::json!({"name":name,"data":result})
                )
                .is_ok()
            );
            for key in result.as_object().unwrap().keys() {
                let mut incomplete = result.clone();
                let _removed = incomplete.as_object_mut().unwrap().remove(key);
                assert!(
                    serde_json::from_value::<OperationResponse>(
                        serde_json::json!({"name":name,"data":incomplete})
                    )
                    .is_err(),
                    "{name}.{key}"
                );
            }
        }
        let no_backup = serde_json::json!({"character":"ada","confirm":"ada"});
        let args: DeleteCharacterArgs = serde_json::from_value(no_backup.clone()).unwrap();
        assert_eq!(serde_json::to_value(args).unwrap(), no_backup);
        assert!(
            serde_json::from_value::<DeleteCharacterArgs>(
                serde_json::json!({"character":"ada","confirm":"ada","archive":null})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<DeleteCharacterResult>(
                serde_json::json!({"character":"ada","deleted":true,"removed":[],"archive":null})
            )
            .is_ok()
        );
    }

    #[test]
    fn usage_contracts_preserve_explicit_null_filters_and_require_report_fields() {
        let input = serde_json::json!({"last":null,"character":null,"provider":null,"api_key":null,"model":null,"call_type":null,"group_by":null,"budget":false,"anomalies":false,"export_csv":false,"export_tsv":false});
        let parsed: UsageArgs = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), input);
        assert_eq!(
            serde_json::to_value(UsageArgs::default()).unwrap(),
            serde_json::json!({})
        );
        assert!(
            serde_json::from_value::<UsageArgs>(serde_json::json!({"group_by":"character"}))
                .is_err()
        );
        assert!(serde_json::from_value::<UsageArgs>(serde_json::json!({"budget":"true"})).is_err());
        assert!(
            serde_json::from_value::<NanoGptSubscriptionState>(
                serde_json::json!({"version":2,"fetched_at":"now","active":true,"state":"active"})
            )
            .is_err()
        );
        let reports: Vec<serde_json::Value> =
            serde_json::from_value(recorded_result("usage_reports")).unwrap();
        let plan = reports
            .first()
            .and_then(|summary| summary.get("claude_plan_limits"))
            .cloned()
            .unwrap();
        assert!(plan.is_object());
        let budget = reports
            .iter()
            .find(|report| report.get("mode").and_then(serde_json::Value::as_str) == Some("budget"))
            .unwrap()
            .clone();
        let mut planned = budget.clone();
        let _ = planned
            .as_object_mut()
            .unwrap()
            .insert("claude_plan_limits".to_owned(), plan);
        assert!(serde_json::from_value::<UsageResult>(planned).is_ok());
        let mut nulled = budget;
        let _ = nulled
            .as_object_mut()
            .unwrap()
            .insert("claude_plan_limits".to_owned(), serde_json::Value::Null);
        assert!(serde_json::from_value::<UsageResult>(nulled).is_err());
        for report in reports {
            assert!(serde_json::from_value::<UsageResult>(report.clone()).is_ok());
            for key in report
                .as_object()
                .unwrap()
                .keys()
                .filter(|key| key.as_str() != "period_since")
            {
                let mut incomplete = report.clone();
                assert!(incomplete.as_object_mut().unwrap().remove(key).is_some());
                assert!(
                    serde_json::from_value::<UsageResult>(incomplete).is_err(),
                    "missing {key}"
                );
            }
        }
    }

    #[test]
    fn manual_tool_contracts_keep_structured_arguments_and_complete_result_variants() {
        let value = serde_json::json!({"tool":"fixture","input":{"entries":[{"active":false,"number":0,"unset":null,"text":"first\nsecond"}]},"pairs":{"number":"0"},"raw":true,"describe":false});
        let args: RunToolArgs = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(args).unwrap(), value);
        assert!(serde_json::from_value::<RunToolArgs>(serde_json::json!({"tool":"read"})).is_ok());
        for invalid in [
            serde_json::json!({"tool":"read","input":null}),
            serde_json::json!({"tool":"read","input":[]}),
            serde_json::json!({"tool":"read","pairs":null}),
            serde_json::json!({"tool":"read","pairs":{"limit":1}}),
            serde_json::json!({"tool":"read","raw":"true"}),
            serde_json::json!({"tool":"read","extra":true}),
        ] {
            assert!(serde_json::from_value::<RunToolArgs>(invalid).is_err());
        }
        let reports: Vec<serde_json::Value> =
            serde_json::from_value(recorded_result("tool_results")).unwrap();
        for report in reports {
            let parsed: RunToolResult = serde_json::from_value(report.clone()).unwrap();
            assert_eq!(
                numbers_as_f64(serde_json::to_value(parsed).unwrap()),
                numbers_as_f64(report.clone())
            );
            for key in report.as_object().unwrap().keys() {
                let mut incomplete = report.clone();
                assert!(incomplete.as_object_mut().unwrap().remove(key).is_some());
                assert!(
                    serde_json::from_value::<RunToolResult>(incomplete).is_err(),
                    "missing {key}"
                );
            }
        }
    }

    #[test]
    fn memory_arguments_preserve_explicit_clears_and_omissions() {
        for value in [
            serde_json::json!({}),
            serde_json::json!({"value":null}),
            serde_json::json!({"action":"note","index":0,"value":""}),
        ] {
            let input: SegmentsArgs = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(input).unwrap(), value);
        }
        for value in [
            serde_json::json!({}),
            serde_json::json!({"note":null}),
            serde_json::json!({"exclude":false,"note":"archive"}),
        ] {
            let input: ClearArgs = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(input).unwrap(), value);
        }
        let args = serde_json::json!({"dry_run":true,"restart":false,"keep_turns":0});
        let input: CompactArgs = serde_json::from_value(args.clone()).unwrap();
        let command = CompactConversation::command(input, Some("compact-1".to_owned())).unwrap();
        assert_eq!(
            serde_json::to_value(command).unwrap(),
            serde_json::json!({"name":"compact","rid":"compact-1","args":args})
        );
        for invalid in [
            serde_json::json!({"dry_run":"true"}),
            serde_json::json!({"keep_turns":-1}),
            serde_json::json!({"keep_turns":1.5}),
            serde_json::json!({"restart":1}),
            serde_json::json!({"unknown":null}),
        ] {
            assert!(serde_json::from_value::<CompactArgs>(invalid).is_err());
        }
        assert!(
            serde_json::from_value::<SegmentsArgs>(serde_json::json!({"action":"remove"})).is_err()
        );
    }

    #[test]
    fn memory_result_variants_require_complete_payloads() {
        let reports: Vec<serde_json::Value> =
            serde_json::from_value(recorded_result("memory_compaction")).unwrap();
        for report in reports {
            let parsed: CompactionReport = serde_json::from_value(report.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), report);
            for key in report.as_object().unwrap().keys() {
                let mut incomplete = report.clone();
                assert!(incomplete.as_object_mut().unwrap().remove(key).is_some());
                assert!(
                    serde_json::from_value::<CompactionReport>(incomplete).is_err(),
                    "{key}"
                );
            }
        }
        let listing = recorded_result("memory_segments");
        let parsed: SegmentsResult = serde_json::from_value(listing.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), listing);
        assert!(
            serde_json::from_value::<SegmentsResult>(serde_json::json!({"segments":[]})).is_err()
        );
        assert!(serde_json::from_value::<ClearResult>(serde_json::json!({"status":"clear","character":"ada","thread":"main","message_count":0})).is_err());
    }

    #[test]
    fn diagnostic_requests_preserve_filters_and_reject_invalid_variants() {
        let value = serde_json::json!({"id":2,"against":1,"wire":true,"diff":true,"count":0});
        let input: CallLogArgs = serde_json::from_value(value.clone()).unwrap();
        let command = InspectCalls::command(input, Some("inspect-1".to_owned())).unwrap();
        assert_eq!(
            serde_json::to_value(command).unwrap(),
            serde_json::json!({"name":"call_log","rid":"inspect-1","args":value})
        );
        for invalid in [
            serde_json::json!({"id":1.5}),
            serde_json::json!({"wire":"true"}),
            serde_json::json!({"count":-1}),
            serde_json::json!({"unknown":true}),
        ] {
            assert!(serde_json::from_value::<CallLogArgs>(invalid).is_err());
        }
        assert!(
            serde_json::from_value::<TranscriptArgs>(serde_json::json!({"source":"unknown"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<SubagentTraceArgs>(serde_json::json!({"ids":[1]})).is_err()
        );
        assert!(is_registered_operation("heartbeat_tick_now"));
        assert!(is_registered_operation("status"));
        assert!(!is_registered_operation("unknown_operation"));
    }

    #[test]
    fn runtime_results_require_the_fields_of_the_reported_outcome() {
        assert!(
            serde_json::from_value::<KeepalivePingResult>(
                serde_json::json!({"status":"skipped","character":"ada","reason":"No request"})
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<KeepalivePingResult>(
                serde_json::json!({"status":"warm","character":"ada","reason":"No request"})
            )
            .is_err()
        );
        let result = serde_json::json!({"character":"ada","registered":false,"heartbeat":null,"keepalive":{"status":"unavailable","detail":"No prefix"}});
        assert!(serde_json::from_value::<SessionActivated>(result.clone()).is_ok());
        let mut incomplete = result;
        assert!(
            incomplete
                .as_object_mut()
                .unwrap()
                .remove("heartbeat")
                .is_some()
        );
        assert!(serde_json::from_value::<SessionActivated>(incomplete).is_err());
        assert!(
            serde_json::from_value::<KeepaliveActivation>(
                serde_json::json!({"status":"primed","detail":"missing usage"})
            )
            .is_err()
        );
    }

    #[test]
    fn model_contracts_require_named_writes_and_complete_targeted_results() {
        for args in [serde_json::json!({}), serde_json::json!({"name":null})] {
            assert!(serde_json::from_value::<FavoriteModelArgs>(args).is_err());
        }
        for args in [
            serde_json::json!({"value":0.2}),
            serde_json::json!({"key":null}),
            serde_json::json!({"key":"temperature","scope":"shared"}),
            serde_json::json!({"key":"temperature","background_task":"dreaming"}),
            serde_json::json!({"key":"temperature","typo":true}),
        ] {
            assert!(serde_json::from_value::<SetModelSettingArgs>(args).is_err());
        }
        for value in [
            serde_json::json!(false),
            serde_json::json!(0),
            serde_json::json!({"order":["a"],"allow_fallbacks":false}),
        ] {
            let command = SetModelSetting::command(
                SetModelSettingArgs {
                    name: Some("fixture".to_owned()),
                    background_task: None,
                    subagent: None,
                    key: "openrouter_provider".to_owned(),
                    scope: Some(ModelPreferenceScope::Global),
                    value: Some(value.clone()),
                },
                Some("model-1".to_owned()),
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(command).unwrap(),
                serde_json::json!({"name":"set_model_setting","args":{"name":"fixture","key":"openrouter_provider","scope":"global","value":value},"rid":"model-1"})
            );
        }
        let selected = serde_json::json!({"target":"thread","active":"fixture","qualified_name":"fixture","provider":"anthropic","model_id":"fixture","changed":true,"future_detail":{"inspectable":true}});
        assert!(serde_json::from_value::<ModelSwitchResult>(selected.clone()).is_ok());
        for key in ["qualified_name", "provider", "model_id", "changed"] {
            let mut incomplete = selected.clone();
            assert!(incomplete.as_object_mut().unwrap().remove(key).is_some());
            assert!(serde_json::from_value::<ModelSwitchResult>(incomplete).is_err());
        }
        assert!(
            serde_json::from_value::<ModelSwitchResult>(
                serde_json::json!({"target":"current","active":null})
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<ModelSwitchResult>(
                serde_json::json!({"target":"thread","active":null})
            )
            .is_err()
        );
        let reset = serde_json::json!({"target":"role","active":null,"role":"heartbeat","cleared":[],"source":null,"file":null,"reset_to":"inherited","roles":[{"role":"heartbeat","model":null,"source":null}]});
        assert!(serde_json::from_value::<ModelResetResult>(reset.clone()).is_ok());
        for key in ["active", "source", "file", "roles"] {
            let mut incomplete = reset.clone();
            assert!(incomplete.as_object_mut().unwrap().remove(key).is_some());
            assert!(serde_json::from_value::<ModelResetResult>(incomplete).is_err());
        }
    }

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
                serde_json::json!({"segment":2,"before":40,"role":"assistant"})
            )
            .is_ok()
        );
        assert!(
            serde_json::from_value::<HistoryPageArgs>(serde_json::json!({"before":"active"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<ConversationLogArgs>(serde_json::json!({"segment":0})).is_ok()
        );
        assert!(
            serde_json::from_value::<ConversationLogArgs>(serde_json::json!({"segment":-1}))
                .is_err()
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
