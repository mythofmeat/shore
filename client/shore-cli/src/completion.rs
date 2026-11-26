use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::time::Duration;

use clap::{ArgMatches, Command, CommandFactory as _};
use clap_complete::engine::{ArgValueCandidates, CompletionCandidate, SubcommandCandidates};
use clap_complete::env::Shells;
use clap_complete::{CompleteEnv, Shell};
use serde_json::{Value as Json, json};
use shore_common::protocol::operations::ModelSettingsArgs;
use shore_common::protocol::server_msg::ServerMessage;
use shore_common::protocol::types::{ContentBlock, Message, Role};
use shore_common::swp_client::{SWPConnection, ServerAddr};
use shore_common::token::TokenSource;

use crate::cli::{BackgroundTarget, Cli, ProviderTarget, leading_flag_named};
use crate::state;

const COMPLETE_VAR: &str = "SHORE_COMPLETE";
const BIN: &str = "shore";
const LOOKUP_DEADLINE: Duration = Duration::from_secs(4);
const RECENT_MESSAGES: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Completes {
    AltSelectors,
    CallTypes,
    Calls,
    Characters,
    ConfigKeys,
    ConfigSections,
    ConfigValues,
    Credentials,
    FavoriteModels,
    Folders,
    LimitOff,
    MarkTags,
    MessageRefs,
    Models,
    ProviderPresets,
    ProviderSettingValues,
    ProviderSettings,
    Providers,
    Sdks,
    Sections,
    Segments,
    SettingKeys,
    SettingValues,
    Statuses,
    StatusesOn,
    SubagentRuns,
    Subagents,
    Texts,
    Threads,
    ToolArguments,
    Tools,
    UsageApiKeys,
    UsageModels,
    UsagePeriods,
    UsageProviders,
    WorkspaceFiles,
}

impl Completes {
    fn sources(self) -> &'static [Source] {
        match self {
            Self::AltSelectors | Self::LimitOff | Self::UsagePeriods => &[],
            Self::CallTypes => &[Source::UsageCallTypes],
            Self::Calls => &[Source::Calls],
            Self::Characters => &[Source::Characters],
            Self::ConfigKeys | Self::ConfigSections | Self::ConfigValues => &[Source::Config],
            Self::Credentials | Self::Providers => &[Source::Providers],
            Self::FavoriteModels | Self::Models => &[Source::Models],
            Self::Folders | Self::Threads => &[Source::Threads],
            Self::MarkTags => &[Source::Marks],
            Self::MessageRefs => &[Source::History],
            Self::ProviderPresets | Self::Sdks => &[Source::Presets],
            Self::ProviderSettingValues => &[Source::Config, Source::Presets],
            Self::ProviderSettings => &[Source::Config],
            Self::Sections => &[Source::Status],
            Self::Segments => &[Source::Segments],
            Self::SettingKeys | Self::SettingValues => &[Source::Settings],
            Self::Statuses | Self::StatusesOn => &[Source::Presence],
            Self::SubagentRuns => &[Source::SubagentRuns],
            Self::Texts => &[Source::Texts],
            Self::Subagents | Self::Tools => &[Source::Tools],
            Self::UsageApiKeys => &[Source::UsageApiKeys],
            Self::UsageModels => &[Source::UsageModels],
            Self::UsageProviders => &[Source::UsageProviders],
            Self::ToolArguments => &[Source::ToolParameters],
            Self::WorkspaceFiles => &[Source::WorkspaceFiles],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Source {
    Calls,
    Characters,
    Config,
    History,
    Marks,
    Models,
    Presence,
    Presets,
    Providers,
    Segments,
    Settings,
    Status,
    SubagentRuns,
    Texts,
    Threads,
    ToolParameters,
    Tools,
    UsageApiKeys,
    UsageCallTypes,
    UsageModels,
    UsageProviders,
    WorkspaceFiles,
}

impl Source {
    pub(crate) fn request(self, line: &Line) -> Option<(&'static str, Json)> {
        let usage = |group_by: &str| ("usage", json!({ "last": "all", "group_by": group_by }));
        Some(match self {
            Self::Characters => return None,
            Self::History => ("log", json!({ "count": RECENT_MESSAGES })),
            Self::Calls => ("call_log", json!({ "count": 20 })),
            Self::Config => ("config_schema", json!({})),
            Self::Marks => ("marks", json!({ "refs": [] })),
            Self::Models => ("list_models", json!({})),
            Self::Presence => ("presence", json!({})),
            Self::Presets => ("provider_presets", json!({})),
            Self::Providers => ("list_providers", json!({})),
            Self::Segments => ("segments", json!({})),
            Self::Settings => ("model_settings", line.settings_target()),
            Self::Status => ("status", json!({})),
            Self::SubagentRuns => ("subagent_trace", json!({ "count": 10 })),
            Self::Texts => ("texts", json!({})),
            Self::Threads => ("list_threads", json!({})),
            Self::ToolParameters => return line.debug_tool().map(described_tool),
            Self::WorkspaceFiles => ("workspace_files", json!({})),
            Self::Tools => ("tools", json!({})),
            Self::UsageApiKeys => usage("api_key"),
            Self::UsageCallTypes => usage("call_type"),
            Self::UsageModels => usage("model"),
            Self::UsageProviders => usage("provider"),
        })
    }
}

fn described_tool(tool: &str) -> (&'static str, Json) {
    ("run_tool", json!({ "tool": tool, "describe": true }))
}

pub(crate) fn values(kind: Completes) -> ArgValueCandidates {
    ArgValueCandidates::new(move || candidates_now(kind))
}

pub(crate) fn provider_names() -> SubcommandCandidates {
    SubcommandCandidates::new(|| candidates_now(Completes::Providers))
}

fn candidates_now(kind: Completes) -> Vec<CompletionCandidate> {
    SESSION.with_borrow_mut(|session| {
        let Some(active) = session else {
            return Vec::new();
        };
        active.load(kind);
        active
            .catalog
            .values(kind, &active.line)
            .into_iter()
            .map(|value| {
                CompletionCandidate::new(value.value)
                    .help(value.help.map(clap::builder::StyledStr::from))
            })
            .collect()
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PaletteValue {
    pub value: String,
    pub help: Option<String>,
}

impl PaletteValue {
    pub(crate) fn plain(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            help: None,
        }
    }

    fn described(value: impl Into<String>, help: Option<String>) -> Self {
        Self {
            value: value.into(),
            help: help.filter(|text| !text.is_empty()),
        }
    }
}

fn plain_values(values: &[&str]) -> Vec<PaletteValue> {
    values.iter().copied().map(PaletteValue::plain).collect()
}

#[derive(Clone, Debug, Default)]
pub(crate) struct PaletteCatalog {
    pub models: Vec<PaletteValue>,
    pub favorite_models: Vec<PaletteValue>,
    pub characters: Vec<PaletteValue>,
    pub threads: Vec<PaletteValue>,
    pub folders: Vec<PaletteValue>,
    pub providers: Vec<PaletteValue>,
    pub credentials: BTreeMap<String, Vec<PaletteValue>>,
    pub presets: Vec<PaletteValue>,
    pub sdks: Vec<PaletteValue>,
    pub status_sections: Vec<PaletteValue>,
    pub tools: Vec<PaletteValue>,
    pub subagents: Vec<PaletteValue>,
    pub setting_keys: Vec<PaletteValue>,
    pub setting_values: BTreeMap<String, Vec<PaletteValue>>,
    pub message_refs: Vec<PaletteValue>,
    pub config_keys: Vec<PaletteValue>,
    pub config_sections: Vec<PaletteValue>,
    pub config_schema: Option<Json>,
    pub segments: Vec<PaletteValue>,
    pub calls: Vec<PaletteValue>,
    pub subagent_runs: Vec<PaletteValue>,
    pub usage_providers: Vec<PaletteValue>,
    pub usage_api_keys: Vec<PaletteValue>,
    pub usage_models: Vec<PaletteValue>,
    pub call_types: Vec<PaletteValue>,
    pub workspace_files: Vec<PaletteValue>,
    pub texts: Vec<PaletteValue>,
    pub statuses: Vec<PaletteValue>,
    pub statuses_on: Vec<PaletteValue>,
    like_tags: Vec<PaletteValue>,
    dislike_tags: Vec<PaletteValue>,
    tool_arguments: Vec<PaletteValue>,
}

impl PaletteCatalog {
    pub(crate) fn absorb(&mut self, source: Source, data: &Json) {
        match source {
            Source::Characters => {}
            Source::History => self.absorb_history(data),
            Source::Calls => self.calls = call_values(data),
            Source::Config => self.absorb_config(data),
            Source::Marks => {
                self.like_tags = named_values(data, "like_tags");
                self.dislike_tags = named_values(data, "dislike_tags");
            }
            Source::Models => self.absorb_models(data),
            Source::Presence => {
                self.statuses = named_values(data, "history");
                self.statuses_on = rows(data, "statuses")
                    .filter_map(|status| text(status, "status"))
                    .map(PaletteValue::plain)
                    .collect();
            }
            Source::Presets => self.absorb_presets(data),
            Source::Providers => self.absorb_providers(data),
            Source::Segments => self.segments = segment_values(data),
            Source::Settings => self.absorb_settings(data),
            Source::Status => self.status_sections = named_values(data, "sections"),
            Source::SubagentRuns => self.subagent_runs = subagent_run_values(data),
            Source::Threads => {
                self.threads = thread_values(data);
                self.folders = folder_values(data);
            }
            Source::ToolParameters => self.tool_arguments = tool_argument_values(data),
            Source::Tools => self.absorb_tools(data),
            Source::WorkspaceFiles => self.workspace_files = named_values(data, "files"),
            Source::Texts => self.texts = text_values(data),
            Source::UsageApiKeys => self.usage_api_keys = usage_values(data, true),
            Source::UsageCallTypes => self.call_types = usage_values(data, false),
            Source::UsageModels => self.usage_models = usage_values(data, true),
            Source::UsageProviders => self.usage_providers = usage_values(data, false),
        }
    }

    fn absorb_config(&mut self, data: &Json) {
        let mut sections = Vec::new();
        let mut keys = Vec::new();
        for entry in rows(data, "schema") {
            let Some(key) = text(entry, "key") else {
                continue;
            };
            if key.contains('<') {
                continue;
            }
            let kind = text(entry, "type").unwrap_or("value");
            let help = if flag(entry, "restart_required") {
                format!("{kind}; daemon restart required")
            } else {
                kind.to_owned()
            };
            let value = PaletteValue::described(key, Some(help));
            sections.push(value.clone());
            if flag(entry, "settable") {
                keys.push(value);
            }
        }
        self.config_sections = sections;
        self.config_keys = keys;
        self.config_schema = Some(data.clone());
    }

    fn absorb_models(&mut self, data: &Json) {
        let models = crate::output::models_by_provider(data);
        let value = |model: &Json| {
            text(model, "name").map(|name| {
                PaletteValue::described(name, text(model, "provider").map(str::to_owned))
            })
        };
        self.models = models.iter().filter_map(value).collect();
        self.favorite_models = models
            .iter()
            .filter(|model| flag(model, "favorite"))
            .filter_map(value)
            .collect();
    }

    fn absorb_presets(&mut self, data: &Json) {
        self.presets = rows(data, "presets")
            .filter(|preset| !flag(preset, "configured"))
            .filter_map(|preset| {
                let name = text(preset, "name")?;
                Some(PaletteValue::described(
                    name,
                    text(preset, "sdk").map(str::to_owned),
                ))
            })
            .collect();
        self.sdks = named_values(data, "sdks");
    }

    fn absorb_providers(&mut self, data: &Json) {
        self.providers = rows(data, "providers")
            .filter_map(|provider| {
                let name = text(provider, "name")?;
                Some(PaletteValue::described(
                    name,
                    text(provider, "sdk").map(str::to_owned),
                ))
            })
            .collect();
        self.credentials = rows(data, "providers")
            .filter_map(|provider| {
                let name = text(provider, "name")?;
                let credentials = rows(provider, "credentials")
                    .filter_map(|credential| {
                        let credential_name = text(credential, "name")?;
                        Some(PaletteValue::described(
                            credential_name,
                            joined(&[text(credential, "kind"), text(credential, "standing")]),
                        ))
                    })
                    .collect();
                Some((name.to_owned(), credentials))
            })
            .collect();
    }

    fn absorb_settings(&mut self, data: &Json) {
        let effective = data.get("effective_sampler").and_then(Json::as_object);
        let usable = || {
            rows(data, "setting_schema")
                .filter(|entry| matches!(text(entry, "applicability"), Some("always" | "honored")))
        };
        self.setting_keys = usable()
            .filter_map(|entry| {
                let key = text(entry, "key")?;
                let current = effective
                    .and_then(|settings| settings.get(key))
                    .filter(|value| !value.is_null())
                    .map_or_else(|| "unset".to_owned(), rendered_setting);
                Some(PaletteValue::described(key, Some(current)))
            })
            .collect();
        self.setting_values = usable()
            .filter_map(|entry| {
                let key = text(entry, "key")?;
                Some((key.to_owned(), named_values(entry, "suggestions")))
            })
            .collect();
    }

    fn absorb_tools(&mut self, data: &Json) {
        let mut tools = described_values(data, "tools");
        tools.extend(described_values(data, "mcp"));
        self.subagents = described_values(data, "subagents");
        tools.extend(self.subagents.iter().map(|subagent| PaletteValue {
            value: format!("ask_{}", subagent.value),
            help: subagent.help.clone(),
        }));
        tools.sort_by(|left, right| left.value.cmp(&right.value));
        tools.dedup_by(|left, right| left.value == right.value);
        self.tools = tools;
    }

    fn absorb_history(&mut self, data: &Json) {
        let messages: Vec<Message> = data
            .get("messages")
            .cloned()
            .and_then(|listed| serde_json::from_value(listed).ok())
            .unwrap_or_default();
        self.message_refs = messages
            .iter()
            .rev()
            .take(RECENT_MESSAGES)
            .map(|message| {
                PaletteValue::described(
                    message.msg_id.clone(),
                    Some(format!("{} {}", role_name(&message.role), snippet(message))),
                )
            })
            .collect();
    }

    fn config_values(&self, key: &str) -> Vec<PaletteValue> {
        self.config_schema
            .as_ref()
            .map_or_else(Vec::new, |schema| config_value_candidates(key, schema))
    }

    fn provider_settings(&self, provider: &str) -> Vec<PaletteValue> {
        let Some(schema) = self.config_schema.as_ref() else {
            return Vec::new();
        };
        let prefix = format!("providers.{provider}.");
        let settings = |under: &str| {
            rows(schema, "schema")
                .filter(|entry| flag(entry, "settable"))
                .filter_map(|entry| {
                    let setting = text(entry, "key")?.strip_prefix(under)?;
                    (!setting.contains('.')).then(|| {
                        PaletteValue::described(
                            setting.replace('_', "-"),
                            text(entry, "type").map(str::to_owned),
                        )
                    })
                })
                .collect::<Vec<_>>()
        };
        let named = settings(&prefix);
        if named.is_empty() {
            settings("providers.<name>.")
        } else {
            named
        }
    }

    fn provider_setting_values(&self, provider: &str, setting: &str) -> Vec<PaletteValue> {
        let key = setting.trim().replace('-', "_");
        if key == "sdk" {
            return self.sdks.clone();
        }
        let named = self.config_values(&format!("providers.{provider}.{key}"));
        if named.is_empty() {
            self.config_values(&format!("providers.<name>.{key}"))
        } else {
            named
        }
    }

    fn credentials_of(&self, provider: &str) -> Vec<PaletteValue> {
        self.credentials
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(provider))
            .map_or_else(Vec::new, |(_, credentials)| credentials.clone())
    }

    fn values(&self, kind: Completes, line: &Line) -> Vec<PaletteValue> {
        match kind {
            Completes::AltSelectors => {
                plain_values(&["list", "prev", "next", "first", "last", "1", "2", "3"])
            }
            Completes::CallTypes => self.call_types.clone(),
            Completes::Calls => self.calls.clone(),
            Completes::Characters => self.characters.clone(),
            Completes::ConfigKeys => self.config_keys.clone(),
            Completes::ConfigSections => self.config_sections.clone(),
            Completes::ConfigValues => line
                .text(&["config", "set"], "key")
                .map_or_else(Vec::new, |key| self.config_values(key)),
            Completes::Credentials => line
                .provider()
                .map_or_else(Vec::new, |provider| self.credentials_of(provider)),
            Completes::FavoriteModels => self.favorite_models.clone(),
            Completes::Folders => self.folders.clone(),
            Completes::LimitOff => plain_values(&["off"]),
            Completes::MarkTags => {
                if line.at(&["msg", "like"]).is_some() {
                    self.like_tags.clone()
                } else {
                    self.dislike_tags.clone()
                }
            }
            Completes::MessageRefs => {
                let mut refs = plain_values(&["last", "-1", "-2", "-3"]);
                refs.extend(self.message_refs.iter().cloned());
                refs
            }
            Completes::Models => self.models.clone(),
            Completes::ProviderPresets => self.presets.clone(),
            Completes::ProviderSettingValues => line
                .provider()
                .zip(line.provider_setting())
                .map_or_else(Vec::new, |(provider, setting)| {
                    self.provider_setting_values(provider, setting)
                }),
            Completes::ProviderSettings => line
                .provider()
                .map_or_else(Vec::new, |provider| self.provider_settings(provider)),
            Completes::Providers => self.providers.clone(),
            Completes::Sdks => self.sdks.clone(),
            Completes::Sections => self.status_sections.clone(),
            Completes::Segments => self.segments.clone(),
            Completes::SettingKeys => self.setting_keys.clone(),
            Completes::SettingValues => line
                .text(&["model", "setting"], "key")
                .and_then(|key| self.setting_values.get(key).cloned())
                .unwrap_or_default(),
            Completes::SubagentRuns => self.subagent_runs.clone(),
            Completes::Subagents => self.subagents.clone(),
            Completes::Texts => self.texts.clone(),
            Completes::Threads => self.threads.clone(),
            Completes::ToolArguments => {
                let used = line.used_tool_arguments();
                self.tool_arguments
                    .iter()
                    .filter(|argument| {
                        let name = argument.value.split('=').next().unwrap_or_default();
                        !used.iter().any(|taken| taken == name)
                    })
                    .cloned()
                    .collect()
            }
            Completes::Tools => self.tools.clone(),
            Completes::UsageApiKeys => self.usage_api_keys.clone(),
            Completes::UsageModels => self.usage_models.clone(),
            Completes::UsagePeriods => plain_values(&["today", "week", "month", "all"]),
            Completes::UsageProviders => self.usage_providers.clone(),
            Completes::WorkspaceFiles => self.workspace_files.clone(),
            Completes::Statuses => self.statuses.clone(),
            Completes::StatusesOn => self.statuses_on.clone(),
        }
    }
}

fn rows<'data>(data: &'data Json, array: &str) -> impl Iterator<Item = &'data Json> {
    data.get(array)
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
}

fn text<'data>(data: &'data Json, key: &str) -> Option<&'data str> {
    data.get(key).and_then(Json::as_str)
}

fn flag(data: &Json, key: &str) -> bool {
    data.get(key).and_then(Json::as_bool).unwrap_or(false)
}

fn joined(parts: &[Option<&str>]) -> Option<String> {
    let kept = parts.iter().copied().flatten().collect::<Vec<_>>();
    (!kept.is_empty()).then(|| kept.join(" \u{b7} "))
}

fn named_values(data: &Json, array: &str) -> Vec<PaletteValue> {
    rows(data, array)
        .filter_map(Json::as_str)
        .map(PaletteValue::plain)
        .collect()
}

fn text_values(data: &Json) -> Vec<PaletteValue> {
    rows(data, "texts")
        .filter_map(|item| {
            Some(PaletteValue::described(
                text(item, "name")?,
                text(item, "place").map(str::to_owned),
            ))
        })
        .collect()
}

fn described_values(data: &Json, array: &str) -> Vec<PaletteValue> {
    rows(data, array)
        .filter_map(|item| {
            let value = item
                .as_str()
                .or_else(|| text(item, "name"))
                .or_else(|| text(item, "id"))
                .or_else(|| text(item, "tool"))?;
            let help = text(item, "description")
                .or_else(|| text(item, "type"))
                .map(str::to_owned);
            Some(PaletteValue::described(value, help))
        })
        .collect()
}

fn thread_values(data: &Json) -> Vec<PaletteValue> {
    rows(data, "threads")
        .filter_map(|thread| {
            let id = text(thread, "id")?;
            Some(PaletteValue::described(
                id,
                text(thread, "label").map(str::to_owned),
            ))
        })
        .collect()
}

fn folder_values(data: &Json) -> Vec<PaletteValue> {
    rows(data, "folders")
        .filter_map(|folder| text(folder, "name").map(PaletteValue::plain))
        .collect()
}

fn segment_values(data: &Json) -> Vec<PaletteValue> {
    let mut segments = rows(data, "segments")
        .filter_map(|segment| {
            let index = segment.get("index").and_then(Json::as_u64)?;
            let count = segment.get("turn_count").and_then(Json::as_u64);
            let help = text(segment, "label")
                .map(str::to_owned)
                .or_else(|| count.map(crate::output::turns));
            Some((index, help))
        })
        .collect::<Vec<_>>();
    segments.sort_by_key(|&(index, _)| std::cmp::Reverse(index));
    segments
        .into_iter()
        .map(|(index, help)| PaletteValue::described(index.to_string(), help))
        .collect()
}

fn call_values(data: &Json) -> Vec<PaletteValue> {
    rows(data, "entries")
        .filter_map(|call| {
            let id = call.get("id").and_then(Json::as_i64)?;
            Some(PaletteValue::described(
                id.to_string(),
                joined(&[
                    text(call, "call_type"),
                    text(call, "model"),
                    text(call, "ts"),
                ]),
            ))
        })
        .collect()
}

fn subagent_run_values(data: &Json) -> Vec<PaletteValue> {
    rows(data, "entries")
        .filter_map(|run| {
            let id = text(run, "parent_tool_use_id")?;
            Some(PaletteValue::described(
                id,
                joined(&[text(run, "subagent"), text(run, "ts")]),
            ))
        })
        .collect()
}

fn usage_values(data: &Json, grouped_under_provider: bool) -> Vec<PaletteValue> {
    let mut values = rows(data, "summary")
        .filter_map(|row| text(row, "group"))
        .map(|group| match group.split_once(' ') {
            Some((provider, name)) if grouped_under_provider => {
                PaletteValue::described(name, Some(provider.to_owned()))
            }
            _ => PaletteValue::plain(group),
        })
        .collect::<Vec<_>>();
    values.dedup_by(|left, right| left.value == right.value);
    let mut seen = BTreeSet::new();
    values.retain(|value| seen.insert(value.value.clone()));
    values
}

fn tool_argument_values(data: &Json) -> Vec<PaletteValue> {
    let schema = data.get("input_schema").unwrap_or(&Json::Null);
    let Some(properties) = schema.get("properties").and_then(Json::as_object) else {
        return Vec::new();
    };
    let required = |name: &str| rows(schema, "required").any(|item| item.as_str() == Some(name));
    let mut ordered = properties.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|&(name, _)| !required(name));
    ordered
        .into_iter()
        .flat_map(|(name, property)| {
            let help = text(property, "description")
                .and_then(|description| description.lines().next())
                .map(str::to_owned);
            let choices = rows(property, "enum")
                .filter_map(Json::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let spelled = if !choices.is_empty() {
                choices
            } else if text(property, "type") == Some("boolean") {
                vec!["true".to_owned(), "false".to_owned()]
            } else {
                vec![String::new()]
            };
            spelled
                .into_iter()
                .map(move |value| PaletteValue::described(format!("{name}={value}"), help.clone()))
        })
        .collect()
}

fn rendered_setting(value: &Json) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

fn config_value_candidates(key: &str, schema: &Json) -> Vec<PaletteValue> {
    let Some(entry) = rows(schema, "schema").find(|entry| text(entry, "key") == Some(key)) else {
        return Vec::new();
    };
    if let Some(source) = text(entry, "source")
        && let Some(sources) = schema.get("sources")
    {
        let from_source = named_values(sources, source);
        if !from_source.is_empty() {
            return from_source;
        }
    }
    named_values(entry, "values")
}

const fn role_name(role: &Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::System => "system",
    }
}

fn snippet(message: &Message) -> String {
    const SNIPPET_CHARS: usize = 48;
    let first_line = message
        .content_blocks
        .iter()
        .find_map(|block| match block {
            ContentBlock::Text { text, .. } => Some(text.as_str()),
            ContentBlock::Thinking { .. }
            | ContentBlock::ToolUse { .. }
            | ContentBlock::RedactedThinking { .. }
            | ContentBlock::Image { .. }
            | ContentBlock::ToolResult { .. } => None,
        })
        .unwrap_or(message.content.as_str())
        .lines()
        .next()
        .unwrap_or_default();
    first_line.chars().take(SNIPPET_CHARS).collect()
}

pub(crate) struct Line {
    matches: Option<ArgMatches>,
    provider: Option<String>,
}

impl Line {
    fn parse(grammar: &Command, words: &[String]) -> Self {
        let argv = std::iter::once(BIN.to_owned()).chain(words.iter().cloned());
        Self {
            matches: grammar.clone().try_get_matches_from(argv).ok(),
            provider: named_provider(words).map(str::to_owned),
        }
    }

    fn at(&self, path: &[&str]) -> Option<&ArgMatches> {
        path.iter()
            .try_fold(self.matches.as_ref()?, |matches, name| {
                matches.subcommand_matches(name)
            })
    }

    fn text(&self, path: &[&str], id: &str) -> Option<&str> {
        self.at(path)?
            .try_get_one::<String>(id)
            .ok()
            .flatten()
            .map(String::as_str)
    }

    fn provider(&self) -> Option<&str> {
        self.provider.as_deref()
    }

    fn debug_tool(&self) -> Option<&str> {
        self.text(&["debug", "tool"], "name")
    }

    fn used_tool_arguments(&self) -> Vec<String> {
        self.at(&["debug", "tool"])
            .and_then(|matches| {
                matches
                    .try_get_many::<(String, String)>("args")
                    .ok()
                    .flatten()
            })
            .map(|pairs| pairs.map(|(name, _)| name.clone()).collect())
            .unwrap_or_default()
    }

    fn provider_setting(&self) -> Option<&str> {
        let provider = self.provider()?;
        self.text(&["provider", provider, "set"], "setting")
    }

    fn settings_target(&self) -> Json {
        let path = ["model", "setting"];
        let background = self
            .at(&path)
            .and_then(|matches| {
                matches
                    .try_get_one::<BackgroundTarget>("background")
                    .ok()
                    .flatten()
            })
            .map(|target| target.as_protocol_target());
        serde_json::to_value(ModelSettingsArgs {
            name: self.text(&path, "model").map(str::to_owned),
            background_task: background,
            subagent: self.text(&path, "subagent").map(str::to_owned),
            key: None,
            overview: None,
        })
        .unwrap_or_else(|_| json!({}))
    }

    fn subcommand_path(&self) -> Vec<String> {
        let mut path = Vec::new();
        let mut current = self.matches.as_ref();
        while let Some((name, next)) = current.and_then(ArgMatches::subcommand) {
            path.push(name.to_owned());
            current = Some(next);
        }
        path
    }

    fn connection_target(&self) -> (Option<String>, Option<String>, Option<String>) {
        let character = self
            .text(&[], "character")
            .map(str::to_owned)
            .or_else(state::read_active_character);
        let thread = self
            .text(&[], "thread")
            .map(str::to_owned)
            .or_else(|| character.as_deref().and_then(state::read_active_thread));
        (self.text(&[], "addr").map(str::to_owned), character, thread)
    }
}

fn after_leading_flags(words: &[String]) -> &[String] {
    let mut rest = words;
    while let Some((word, tail)) = rest.split_first() {
        let spelled = word.split('=').next().unwrap_or(word);
        if leading_flag_named(spelled).is_none() {
            break;
        }
        rest = if word.contains('=') {
            tail
        } else {
            tail.split_first()
                .map_or(tail, |(_, after_value)| after_value)
        };
    }
    rest
}

fn named_provider(words: &[String]) -> Option<&str> {
    let mut rest = after_leading_flags(words)
        .iter()
        .filter(|word| !word.starts_with('-'));
    (rest.next()?.as_str() == "provider").then_some(())?;
    let name = rest.next()?.as_str();
    let is_own_subcommand = Cli::command()
        .find_subcommand("provider")
        .is_some_and(|provider| provider.find_subcommand(name).is_some());
    (!is_own_subcommand).then_some(name)
}

fn grammar(words: &[String]) -> Command {
    let mut command = Cli::command().ignore_errors(true);
    if let Some(name) = named_provider(words) {
        let target = ProviderTarget::command().name(name.to_owned());
        command = command.mut_subcommand("provider", |provider| provider.subcommand(target));
    }
    command.build();
    command
}

fn edit_at(command: Command, path: &[String], edit: &dyn Fn(Command) -> Command) -> Command {
    match path.split_first() {
        None => edit(command),
        Some((head, rest)) => command.mut_subcommand(head.clone(), |sub| edit_at(sub, rest, edit)),
    }
}

fn spelled_values(arg: &clap::Arg) -> Vec<String> {
    let possible = arg
        .get_possible_values()
        .into_iter()
        .map(|value| value.get_name().to_owned());
    let candidates = arg
        .get::<ArgValueCandidates>()
        .into_iter()
        .flat_map(ArgValueCandidates::candidates)
        .map(|candidate| candidate.get_value().to_string_lossy().into_owned());
    possible.chain(candidates).collect()
}

fn equals_forms(leaf: &Command, current: &str) -> Vec<clap::Arg> {
    if !current.starts_with("--") {
        return Vec::new();
    }
    leaf.get_arguments()
        .filter(|arg| arg.is_require_equals_set())
        .filter_map(|arg| Some((arg, arg.get_long()?)))
        .filter(|(_, long)| format!("--{long}").starts_with(current))
        .flat_map(|(arg, long)| {
            spelled_values(arg).into_iter().map(move |value| {
                let form = format!("{long}={value}");
                clap::Arg::new(form.clone()).long(form).num_args(0)
            })
        })
        .collect()
}

fn fit_flags_to_cursor(
    command: Command,
    path: &[String],
    previous: Option<&str>,
    current: &str,
) -> Command {
    let edit = |leaf: Command| {
        let forms = equals_forms(&leaf, current);
        leaf.mut_args(|arg| {
            let bare_before_cursor = arg.is_require_equals_set()
                && arg
                    .get_long()
                    .is_some_and(|long| previous == Some(format!("--{long}").as_str()));
            if bare_before_cursor {
                arg.num_args(0)
            } else {
                arg
            }
        })
        .args(forms)
    };
    edit_at(command, path, &edit)
}

fn hide_flags(command: Command) -> Command {
    command
        .mut_args(|arg| {
            if arg.is_positional() {
                arg
            } else {
                arg.hide(true)
            }
        })
        .mut_subcommands(hide_flags)
}

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

struct Session {
    line: Line,
    catalog: PaletteCatalog,
    daemon: Option<Daemon>,
}

impl Session {
    fn load(&mut self, kind: Completes) {
        let Some(daemon) = self.daemon.as_mut() else {
            return;
        };
        for &source in kind.sources() {
            daemon.load(source, &self.line, &mut self.catalog);
        }
    }
}

struct Daemon {
    runtime: Option<tokio::runtime::Runtime>,
    connection: Option<SWPConnection>,
    connect_failed: bool,
}

impl Daemon {
    fn new() -> Self {
        Self {
            runtime: tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok(),
            connection: None,
            connect_failed: false,
        }
    }

    fn load(&mut self, source: Source, line: &Line, catalog: &mut PaletteCatalog) {
        let (given_addr, character, thread) = line.connection_target();
        let found_addr = match given_addr {
            Some(given) => Some(ServerAddr(given)),
            None => shore_common::swp_client::discover_or_default(None).ok(),
        };
        let Some(addr) = found_addr else {
            return;
        };
        self.connect(&addr, character, thread, catalog);
        let Some((name, args)) = source.request(line) else {
            return;
        };
        if let Some(data) = self.ask(name, args) {
            catalog.absorb(source, &data);
        }
    }

    fn connect(
        &mut self,
        addr: &ServerAddr,
        character: Option<String>,
        thread: Option<String>,
        catalog: &mut PaletteCatalog,
    ) {
        if self.connection.is_some() || self.connect_failed {
            return;
        }
        let Some(runtime) = self.runtime.as_ref() else {
            return;
        };
        let connected = runtime.block_on(async {
            tokio::time::timeout(
                LOOKUP_DEADLINE,
                SWPConnection::connect_in_thread(
                    addr,
                    "cli",
                    "shore-cli",
                    character,
                    thread,
                    &TokenSource::Discover,
                ),
            )
            .await
        });
        match connected {
            Ok(Ok((connection, hello, _history))) => {
                catalog.characters = hello
                    .characters
                    .into_iter()
                    .map(|served| PaletteValue::plain(served.name))
                    .collect();
                self.connection = Some(connection);
            }
            Ok(Err(_)) | Err(_) => self.connect_failed = true,
        }
    }

    fn ask(&mut self, name: &'static str, args: Json) -> Option<Json> {
        let runtime = self.runtime.as_ref()?;
        let connection = self.connection.as_mut()?;
        runtime
            .block_on(async {
                tokio::time::timeout(LOOKUP_DEADLINE, async {
                    let _rid = connection.send_command(name, args).await.ok()?;
                    answer_to_last_request(connection).await
                })
                .await
            })
            .ok()
            .flatten()
    }
}

#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "a completion lookup only waits for its own answer and drops every other frame"
)]
async fn answer_to_last_request(connection: &mut SWPConnection) -> Option<Json> {
    loop {
        let message = connection.recv().await.ok()?;
        if !connection.matches_last_request(&message) {
            continue;
        }
        match message {
            ServerMessage::CommandOutput(output) => return Some(output.data),
            ServerMessage::Error(_) | ServerMessage::Shutdown(_) => return None,
            _ => {}
        }
    }
}

fn shell_words() -> (Vec<String>, String) {
    let args = std::env::args_os().collect::<Vec<OsString>>();
    let start = args
        .iter()
        .position(|arg| arg == "--")
        .map_or(args.len(), |escape| escape.saturating_add(2));
    let mut words = args
        .get(start..)
        .unwrap_or_default()
        .iter()
        .map(|word| word.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let cursor = std::env::var("_CLAP_COMPLETE_INDEX")
        .ok()
        .and_then(|index| index.parse::<usize>().ok())
        .and_then(|index| index.checked_sub(1))
        .unwrap_or_else(|| words.len().saturating_sub(1));
    let current = words.get(cursor).cloned().unwrap_or_default();
    words.truncate(cursor);
    (words, current)
}

fn shell_command() -> Command {
    let (before, current) = shell_words();
    completing(
        &before,
        &current,
        PaletteCatalog::default(),
        Some(Daemon::new()),
    )
}

fn completing(
    before: &[String],
    current: &str,
    catalog: PaletteCatalog,
    daemon: Option<Daemon>,
) -> Command {
    let command = grammar(before);
    let line = Line::parse(&command, before);
    let path = line.subcommand_path();
    SESSION.set(Some(Session {
        line,
        catalog,
        daemon,
    }));
    let fitted = fit_flags_to_cursor(command, &path, before.last().map(String::as_str), current);
    if current.starts_with('-') {
        fitted
    } else {
        hide_flags(fitted)
    }
}

pub(crate) fn answer_shell() {
    if std::env::var_os(COMPLETE_VAR).is_none() {
        return;
    }
    std::panic::set_hook(Box::new(|_| {}));
    CompleteEnv::with_factory(shell_command)
        .var(COMPLETE_VAR)
        .bin(BIN)
        .completer(BIN)
        .complete();
}

fn registration_script(shell: Shell) -> String {
    let mut script = Vec::new();
    if let Some(completer) = Shells::builtins().completer(&shell.to_string()) {
        _ = completer.write_registration(COMPLETE_VAR, BIN, BIN, BIN, &mut script);
    }
    String::from_utf8_lossy(&script).into_owned()
}

pub(crate) fn print_completions(shell: Shell) {
    cli_write!("{}", registration_script(shell));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filled_catalog() -> PaletteCatalog {
        let names = |list: &[&str]| plain_values(list);
        let mut catalog = PaletteCatalog {
            models: names(&["sonnet", "opus"]),
            favorite_models: names(&["opus"]),
            characters: names(&["alice", "bob"]),
            threads: names(&["main", "story"]),
            folders: names(&["fiction"]),
            status_sections: names(&["tokens"]),
            ..PaletteCatalog::default()
        };
        catalog.absorb(
            Source::Providers,
            &json!({ "providers": [
                { "name": "openrouter", "sdk": "openrouter", "credentials": [
                    { "name": "work", "kind": "api_key" },
                    { "name": "personal", "kind": "api_key" },
                ]},
                { "name": "anthropic", "sdk": "anthropic", "credentials": [
                    { "name": "default", "kind": "api_key" },
                ]},
            ]}),
        );
        catalog.absorb(
            Source::Presets,
            &json!({
                "presets": [
                    { "name": "openrouter", "sdk": "openrouter", "configured": true },
                    { "name": "gemini", "sdk": "gemini", "configured": false },
                ],
                "sdks": ["openai", "gemini"],
            }),
        );
        catalog.absorb(
            Source::Config,
            &json!({ "schema": [
                { "key": "triggers.enabled", "type": "boolean", "settable": true, "values": ["true", "false"] },
                { "key": "chat.model", "type": "string", "settable": true, "values": [], "source": "chat_models" },
                { "key": "providers.openrouter.discover", "type": "boolean", "settable": true, "values": ["true", "false"] },
                { "key": "providers.openrouter.base_url", "type": "string", "settable": true, "values": [] },
                { "key": "providers.openrouter.sdk", "type": "string", "settable": true, "values": [] },
                { "key": "providers.openrouter.keys", "type": "list of table", "settable": false, "values": [] },
            ], "sources": { "chat_models": ["anthropic:opus"] } }),
        );
        catalog.absorb(
            Source::Segments,
            &json!({ "segments": [
                { "index": 1, "turn_count": 4 },
                { "index": 2, "turn_count": 9, "label": "the storm" },
            ]}),
        );
        catalog.absorb(
            Source::UsageCallTypes,
            &json!({ "summary": [{ "group": "message" }, { "group": "wake" }] }),
        );
        catalog.absorb(
            Source::UsageModels,
            &json!({ "summary": [{ "group": "anthropic opus" }, { "group": "openrouter opus" }] }),
        );
        catalog.absorb(
            Source::WorkspaceFiles,
            &json!({ "files": ["MEMORY.md", "notes/lighthouse.md"] }),
        );
        catalog.absorb(
            Source::Presence,
            &json!({
                "statuses": [{ "status": "asleep", "set_at": "2026-11-22T01:00:00.000Z" }],
                "history": ["asleep", "busy", "in bed"]
            }),
        );
        catalog.absorb(
            Source::Marks,
            &json!({ "like_tags": ["warm"], "dislike_tags": ["flat", "long"], "replies": [] }),
        );
        catalog
    }

    fn completed(input: &str, catalog: PaletteCatalog) -> Vec<(String, Option<String>)> {
        let mut before = input
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let current = if input.ends_with(' ') {
            String::new()
        } else {
            before.pop().unwrap_or_default()
        };
        let mut command = completing(&before, &current, catalog, None);
        let mut argv = vec![OsString::from(BIN)];
        argv.extend(before.iter().map(OsString::from));
        argv.push(OsString::from(current));
        let cursor = argv.len().saturating_sub(1);
        clap_complete::engine::complete(&mut command, argv, cursor, None)
            .unwrap_or_default()
            .into_iter()
            .map(|candidate| {
                (
                    candidate.get_value().to_string_lossy().into_owned(),
                    candidate.get_help().map(ToString::to_string),
                )
            })
            .collect()
    }

    fn offered(input: &str) -> Vec<String> {
        offered_with_help(input, &filled_catalog())
            .into_iter()
            .map(|(value, _)| value)
            .collect()
    }

    #[test]
    fn each_position_offers_the_values_it_accepts() {
        let cases: &[(&str, &[&str])] = &[
            (
                "provider ",
                &["models", "refresh", "add", "anthropic", "openrouter"],
            ),
            ("provider open", &["openrouter"]),
            ("presence ", &["asleep", "busy", "in bed"]),
            ("presence b", &["busy"]),
            ("presence --off ", &["asleep"]),
            ("presence --forget i", &["in bed"]),
            (
                "provider openrouter ",
                &[
                    "set", "unset", "enable", "disable", "remove", "auth", "use", "limit",
                    "models", "refresh",
                ],
            ),
            ("provider openrouter auth ", &["work", "personal"]),
            ("provider anthropic auth ", &["default"]),
            ("provider openrouter use ", &["work", "personal"]),
            ("provider openrouter limit ", &["work", "personal"]),
            ("provider openrouter limit work --spend ", &["off"]),
            ("provider openrouter set ", &["discover", "base-url", "sdk"]),
            (
                "provider openrouter unset ",
                &["discover", "base-url", "sdk"],
            ),
            ("provider openrouter set discover ", &["true", "false"]),
            ("provider openrouter set sdk ", &["openai", "gemini"]),
            ("provider add ", &["gemini"]),
            ("provider add --sdk ", &["openai", "gemini"]),
            ("provider models ", &["openrouter", "anthropic"]),
            ("provider refresh ", &["openrouter", "anthropic"]),
            ("thread lock ", &["main", "story"]),
            ("thread pins story ", &["MEMORY.md", "notes/lighthouse.md"]),
            ("thread new x --pin ", &["MEMORY.md", "notes/lighthouse.md"]),
            ("thread unlock ", &["main", "story"]),
            ("thread compaction ", &["main", "story"]),
            ("thread compaction story ", &["on", "off"]),
            ("thread move ", &["main", "story"]),
            ("thread move story --folder ", &["fiction"]),
            ("thread move story --before ", &["main", "story"]),
            ("thread folder delete ", &["fiction"]),
            ("thread folder sort fiction ", &["activity", "manual"]),
            ("export ", &["alice", "bob"]),
            ("--thread ", &["main", "story"]),
            ("model unfav ", &["opus"]),
            ("model fav ", &["sonnet", "opus"]),
            ("config set triggers.enabled ", &["true", "false"]),
            ("config set chat.model ", &["anthropic:opus"]),
            (
                "config keys ",
                &[
                    "triggers.enabled",
                    "chat.model",
                    "providers.openrouter.discover",
                    "providers.openrouter.base_url",
                    "providers.openrouter.sdk",
                    "providers.openrouter.keys",
                ],
            ),
            ("segments show ", &["2", "1"]),
            ("log --segment ", &["2", "1"]),
            ("usage --call-type ", &["message", "wake"]),
            ("trace calls --call-type ", &["message", "wake"]),
            ("usage --model ", &["opus"]),
            ("usage --last ", &["today", "week", "month", "all"]),
            ("status --section ", &["tokens"]),
            ("msg like --tag ", &["warm"]),
            ("msg like 3 --tag warm --tag ", &["warm"]),
            ("msg dislike --tag ", &["flat", "long"]),
            ("msg regen --tag ", &["flat", "long"]),
        ];
        for (input, expected) in cases {
            assert_eq!(&offered(input), expected, "completing {input:?}");
        }
    }

    #[test]
    fn a_flag_taking_its_value_with_equals_never_offers_it_after_a_space() {
        assert_eq!(
            offered("model use --background "),
            ["sonnet", "opus"],
            "`--background all` is refused, so the next word is the model"
        );
        let forms = completed("model use --b", filled_catalog())
            .into_iter()
            .map(|(value, _)| value)
            .collect::<Vec<_>>();
        assert!(
            forms.iter().any(|form| form.contains("--background=wake")),
            "the spelled-out form is offered with the flag: {forms:?}"
        );
    }

    #[test]
    fn a_segment_is_offered_newest_first_with_its_label_or_else_how_many_turns_it_holds() {
        let mut catalog = PaletteCatalog::default();
        catalog.absorb(
            Source::Segments,
            &json!({ "segments": [
                { "index": 1, "turn_count": 1 },
                { "index": 2, "turn_count": 9, "label": "the storm" },
                { "index": 3, "turn_count": 30 },
            ]}),
        );
        assert_eq!(
            offered_with_help("log --segment ", &catalog),
            described(&[
                ("3", Some("30 turns")),
                ("2", Some("the storm")),
                ("1", Some("1 turn")),
            ])
        );
    }

    fn described_search() -> Json {
        json!({ "tool": "search", "input_schema": {
            "required": ["query"],
            "properties": {
                "limit": { "type": "integer", "description": "How many" },
                "mode": { "type": "string", "enum": ["hybrid", "lexical"], "description": "Which index" },
                "query": { "type": "string", "description": "What to find" },
                "raw": { "type": "boolean" },
            },
        }})
    }

    #[test]
    fn a_tool_lookup_can_only_ever_describe_the_tool() {
        let lookup = |typed: &[&str]| {
            let words = typed.iter().map(ToString::to_string).collect::<Vec<_>>();
            Source::ToolParameters.request(&Line::parse(&grammar(&words), &words))
        };
        assert_eq!(
            lookup(&["debug", "tool", "bash"]),
            Some(("run_tool", json!({ "tool": "bash", "describe": true }))),
            "a keystroke must never be able to run the tool"
        );
        assert_eq!(
            lookup(&["debug", "tool", "read", "path=x"]),
            Some(("run_tool", json!({ "tool": "read", "describe": true })))
        );
        assert_eq!(lookup(&["debug", "tool"]), None, "no tool, nothing to ask");
    }

    #[test]
    fn tool_arguments_lead_with_the_required_and_drop_those_already_given() {
        let mut catalog = PaletteCatalog::default();
        catalog.absorb(Source::ToolParameters, &described_search());
        let offered_here = |input: &str, loaded: &PaletteCatalog| {
            offered_with_help(input, loaded)
                .into_iter()
                .map(|(value, _)| value)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            offered_here("debug tool search ", &catalog),
            [
                "query=",
                "limit=",
                "mode=hybrid",
                "mode=lexical",
                "raw=true",
                "raw=false"
            ],
        );
        assert_eq!(
            offered_here("debug tool search query=cache ", &catalog),
            [
                "limit=",
                "mode=hybrid",
                "mode=lexical",
                "raw=true",
                "raw=false"
            ],
        );
        assert_eq!(
            offered_here("debug tool search query=cache mode=", &catalog),
            ["mode=hybrid", "mode=lexical"],
        );
    }

    #[test]
    fn registration_scripts_name_the_installed_binary_rather_than_the_build_path() {
        for shell in [
            Shell::Bash,
            Shell::Elvish,
            Shell::Fish,
            Shell::PowerShell,
            Shell::Zsh,
        ] {
            let script = registration_script(shell);
            assert!(
                script.contains(COMPLETE_VAR),
                "{shell} asks the binary for its values"
            );
            assert!(
                !script.contains("./shore") && !script.contains("target/"),
                "{shell} must not embed where it was built"
            );
        }
    }

    fn offered_with_help(input: &str, catalog: &PaletteCatalog) -> Vec<(String, Option<String>)> {
        completed(input, catalog.clone())
            .into_iter()
            .filter(|(value, _)| !value.starts_with("--"))
            .collect()
    }

    fn described(expected: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        expected
            .iter()
            .map(|&(value, help)| (value.to_owned(), help.map(str::to_owned)))
            .collect()
    }

    fn daemon_catalog() -> PaletteCatalog {
        let mut catalog = PaletteCatalog::default();
        catalog.absorb(
            Source::Models,
            &json!({ "models": {
                "anthropic": [{ "name": "sonnet" }, { "name": "opus", "favorite": true }],
                "openrouter": [{ "name": "qwen" }],
            }}),
        );
        catalog.absorb(
            Source::Threads,
            &json!({
                "threads": [{ "id": "main", "label": "Home" }, { "id": "story" }, { "label": "no id" }],
                "folders": [{ "name": "fiction" }, { "label": "no name" }],
            }),
        );
        catalog.absorb(
            Source::Providers,
            &json!({ "providers": [{ "name": "openrouter", "sdk": "openrouter", "credentials": [
                { "name": "work", "kind": "api_key", "standing": "active" },
                { "name": "spare", "standing": "spent" },
                { "name": "bare" },
            ]}]}),
        );
        catalog.absorb(
            Source::Calls,
            &json!({ "entries": [
                { "id": 7, "call_type": "message", "model": "opus", "ts": "2026-11-10T01:00:00Z" },
                { "id": 8 },
                { "call_type": "no id" },
            ]}),
        );
        catalog.absorb(
            Source::SubagentRuns,
            &json!({ "entries": [
                { "parent_tool_use_id": "toolu_1", "subagent": "memory", "ts": "2026-11-10T02:00:00Z" },
                { "subagent": "no id" },
            ]}),
        );
        catalog.absorb(
            Source::Tools,
            &json!({
                "tools": [{ "name": "read", "description": "Read a file" }, "bash", { "id": "grep", "type": "builtin" }],
                "mcp": [{ "tool": "mcp__notes__find" }, "bash"],
                "subagents": [{ "name": "memory", "description": "Searches memory" }, "music"],
            }),
        );
        catalog.absorb(
            Source::Settings,
            &json!({
                "setting_schema": [
                    { "key": "temperature", "applicability": "always", "suggestions": ["0.7", "1"] },
                    { "key": "top_p", "applicability": "honored" },
                    { "key": "seed", "applicability": "ignored", "suggestions": ["1"] },
                    { "key": "reasoning_effort", "applicability": "always", "suggestions": ["high"] },
                    { "key": "thinking", "applicability": "always" },
                ],
                "effective_sampler": { "temperature": 0.7, "top_p": null, "reasoning_effort": "high", "thinking": true },
            }),
        );
        catalog.absorb(
            Source::UsageModels,
            &json!({ "summary": [{ "group": "anthropic opus" }, { "group": "openrouter opus" }, { "group": "anthropic sonnet" }, { "group": "unnamed" }] }),
        );
        catalog.absorb(
            Source::UsageApiKeys,
            &json!({ "summary": [{ "group": "anthropic default" }] }),
        );
        catalog.absorb(
            Source::UsageProviders,
            &json!({ "summary": [{ "group": "my provider" }, { "group": "anthropic" }, { "group": "anthropic" }] }),
        );
        catalog.absorb(
            Source::UsageCallTypes,
            &json!({ "summary": [{ "group": "message" }, { "group": "tool loop" }] }),
        );
        catalog.absorb(
            Source::Texts,
            &json!({ "texts": [{ "name": "time", "place": "Before a user's message." }, { "name": "wake" }, { "place": "no name" }] }),
        );
        catalog
    }

    type Described<'expected> = &'expected [(&'expected str, Option<&'expected str>)];

    #[test]
    fn daemon_values_are_offered_with_what_the_daemon_says_about_them() {
        let cases: &[(&str, Described<'_>)] = &[
            (
                "model fav ",
                &[
                    ("opus", Some("anthropic")),
                    ("sonnet", Some("anthropic")),
                    ("qwen", Some("openrouter")),
                ],
            ),
            ("model unfav ", &[("opus", Some("anthropic"))]),
            ("thread lock ", &[("main", Some("Home")), ("story", None)]),
            ("thread move story --folder ", &[("fiction", None)]),
            (
                "provider openrouter auth ",
                &[
                    ("work", Some("api_key \u{b7} active")),
                    ("spare", Some("spent")),
                    ("bare", None),
                ],
            ),
            (
                "trace calls ",
                &[
                    ("7", Some("message \u{b7} opus \u{b7} 2026-11-10T01:00:00Z")),
                    ("8", None),
                ],
            ),
            (
                "trace subagent ",
                &[("toolu_1", Some("memory \u{b7} 2026-11-10T02:00:00Z"))],
            ),
            (
                "debug tool ",
                &[
                    ("ask_memory", Some("Searches memory")),
                    ("ask_music", None),
                    ("bash", None),
                    ("grep", Some("builtin")),
                    ("mcp__notes__find", None),
                    ("read", Some("Read a file")),
                ],
            ),
            (
                "debug subagent ",
                &[("memory", Some("Searches memory")), ("music", None)],
            ),
            (
                "config texts ",
                &[("time", Some("Before a user's message.")), ("wake", None)],
            ),
            (
                "model setting ",
                &[
                    ("temperature", Some("0.7")),
                    ("top_p", Some("unset")),
                    ("reasoning_effort", Some("high")),
                    ("thinking", Some("true")),
                ],
            ),
            ("model setting temperature ", &[("0.7", None), ("1", None)]),
            ("model setting seed ", &[]),
            (
                "usage --model ",
                &[
                    ("opus", Some("anthropic")),
                    ("sonnet", Some("anthropic")),
                    ("unnamed", None),
                ],
            ),
            ("usage --api-key ", &[("default", Some("anthropic"))]),
            (
                "usage --provider ",
                &[("my provider", None), ("anthropic", None)],
            ),
            (
                "usage --call-type ",
                &[("message", None), ("tool loop", None)],
            ),
        ];
        let catalog = daemon_catalog();
        for (input, expected) in cases {
            assert_eq!(
                offered_with_help(input, &catalog),
                described(expected),
                "completing {input:?}"
            );
        }
    }
}
