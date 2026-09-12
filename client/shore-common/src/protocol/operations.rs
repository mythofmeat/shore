use schemars::{JsonSchema, Schema, generate::SchemaSettings};
use serde::{Deserialize, Serialize};

use super::client_msg::Command;
use super::types::CharacterInfo;

macro_rules! wire_types {
    ($($item:item)*) => {$ (
        #[derive(Serialize, Deserialize, Debug, Clone, JsonSchema, ts_rs::TS)]
        #[ts(export, export_to = "../../../daemon/src/protocol/")]
        $item
    )*};
}

wire_types! {
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
