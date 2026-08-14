#![expect(
    clippy::unwrap_used,
    reason = "property-test strategies and assertions intentionally fail fast on invalid generated fixtures"
)]

use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use shore_common::protocol::client_msg::{
    Cancel, ClientHello, ClientMessage, ClientMessageBody, Command, ImageUpload, MessageOverrides,
    Regen,
};
use shore_common::protocol::error::ErrorCode;
use shore_common::protocol::server_msg::{
    CacheWarning, CommandOutput, Error, History, MessageOrigin, NewMessage, Phase, Ping,
    ProviderFallbackWarning, SendImage, ServerHello, ServerMessage, Shutdown, StreamChunk,
    StreamEnd, StreamStart, ToolCall, ToolResult, UsageWarning,
};
use shore_common::protocol::types::{
    CharacterAvatar, CharacterInfo, ContentBlock, ImageRef, Message, MessageAlternative, Role,
    StreamMetadata, TimingInfo, TokenCounts,
};

fn arb_small_string() -> impl Strategy<Value = String> {
    prop::collection::vec(
        prop_oneof![
            Just(b'\n'),
            Just(b'\t'),
            Just(b'e'),
            Just(b'l'),
            Just(b'o'),
            (b' '..=b'~'),
        ],
        0..32,
    )
    .prop_map(|bytes| String::from_utf8(bytes).unwrap())
}

fn arb_ident() -> impl Strategy<Value = String> {
    prop::collection::vec(prop_oneof![(b'a'..=b'z'), (b'0'..=b'9'), Just(b'_')], 1..16)
        .prop_map(|bytes| String::from_utf8(bytes).unwrap())
}

#[expect(
    clippy::float_arithmetic,
    reason = "wire property tests intentionally generate decimal f64 payloads in tenths"
)]
fn arb_decimal(max_tenths: u32) -> impl Strategy<Value = f64> {
    (0_u32..max_tenths).prop_map(|tenths| f64::from(tenths) / 10.0)
}

fn arb_json() -> BoxedStrategy<Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        (0_i64..10_000).prop_map(|n| Value::Number(n.into())),
        arb_small_string().prop_map(Value::String),
    ];

    leaf.prop_recursive(3, 16, 4, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
            prop::collection::btree_map(arb_ident(), inner, 0..4)
                .prop_map(|entries| Value::Object(entries.into_iter().collect())),
        ]
    })
    .boxed()
}

fn arb_role() -> impl Strategy<Value = Role> {
    prop_oneof![Just(Role::User), Just(Role::Assistant), Just(Role::System)]
}

fn arb_image_ref() -> impl Strategy<Value = ImageRef> {
    (
        arb_small_string(),
        prop::option::of(arb_small_string()),
        prop::option::of(arb_small_string()),
    )
        .prop_map(|(path, caption, data)| ImageRef {
            path,
            caption,
            data,
        })
}

fn arb_content_block() -> BoxedStrategy<ContentBlock> {
    prop_oneof![
        arb_small_string().prop_map(|text| ContentBlock::Text { text }),
        (arb_small_string(), prop::option::of(arb_small_string())).prop_map(
            |(thinking, signature)| ContentBlock::Thinking {
                thinking,
                // Through `from_wire`, so a generated string that happens to
                // start with a carrier prefix produces the carrier variant it
                // names — the same value the store would have loaded.
                signature: signature.map(Into::into),
            },
        ),
        (arb_ident(), arb_ident(), arb_json())
            .prop_map(|(id, name, input)| { ContentBlock::ToolUse { id, name, input } }),
        arb_small_string().prop_map(|data| ContentBlock::RedactedThinking { data }),
        (arb_ident(), arb_small_string(), any::<bool>()).prop_map(
            |(tool_use_id, content, is_error)| ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            },
        ),
    ]
    .boxed()
}

fn arb_message_alternative() -> impl Strategy<Value = MessageAlternative> {
    (
        arb_small_string(),
        prop::collection::vec(arb_image_ref(), 0..2),
        prop::collection::vec(arb_content_block(), 0..3),
        arb_small_string(),
        prop::option::of(arb_ident()),
        prop::option::of(arb_ident()),
    )
        .prop_map(
            |(content, images, content_blocks, timestamp, provider_key, model)| {
                MessageAlternative {
                    content,
                    images,
                    content_blocks,
                    timestamp,
                    provider_key,
                    model,
                }
            },
        )
}

fn arb_message() -> impl Strategy<Value = Message> {
    (
        arb_ident(),
        arb_role(),
        arb_small_string(),
        prop::collection::vec(arb_image_ref(), 0..2),
        prop::collection::vec(arb_content_block(), 0..4),
        prop::option::of(0_u32..4),
        prop::option::of(1_u32..5),
        prop::collection::vec(arb_message_alternative(), 0..2),
        prop::option::of(arb_ident()),
        prop::option::of(arb_ident()),
        arb_small_string(),
        prop::option::of(arb_message_origin()),
    )
        .prop_map(
            |(
                msg_id,
                role,
                content,
                images,
                content_blocks,
                alt_index,
                alt_count,
                alternatives,
                provider_key,
                model,
                timestamp,
                origin,
            )| Message {
                msg_id,
                role,
                content,
                images,
                content_blocks,
                alt_index,
                alt_count,
                alternatives,
                timestamp,
                provider_key,
                model,
                origin,
            },
        )
}

fn arb_stream_metadata() -> impl Strategy<Value = StreamMetadata> {
    (
        0_u64..100_000,
        0_u64..100_000,
        0_u64..100_000,
        0_u64..100_000,
        0_u32..100_000,
        0_u32..100_000,
        arb_ident(),
    )
        .prop_map(
            |(input, output, cache_read, cache_write, total_ms, ttft_ms, model)| StreamMetadata {
                tokens: TokenCounts {
                    input,
                    output,
                    cache_read,
                    cache_write,
                },
                timing: TimingInfo { total_ms, ttft_ms },
                model,
            },
        )
}

fn arb_client_message() -> BoxedStrategy<ClientMessage> {
    let hello = (
        arb_ident(),
        arb_ident(),
        prop::collection::vec(arb_ident(), 0..3),
        prop::option::of(arb_ident()),
        prop::option::of(arb_ident()),
    )
        .prop_map(
            |(client_type, client_name, capabilities, character, token)| {
                ClientMessage::Hello(ClientHello {
                    client_type,
                    client_name,
                    capabilities,
                    character,
                    token,
                })
            },
        );

    let image_upload = (
        arb_ident(),
        arb_small_string(),
        prop::option::of(arb_ident()),
    )
        .prop_map(|(filename, data, mime_type)| ImageUpload {
            filename,
            data,
            mime_type,
        });

    let message = (
        prop::option::of(arb_ident()),
        arb_small_string(),
        any::<bool>(),
        prop::collection::vec(arb_small_string(), 0..2),
        prop::collection::vec(image_upload, 0..2),
        prop::option::of(0_u64..100_000),
        prop::option::of((
            prop::option::of(arb_decimal(20)),
            prop::option::of(arb_decimal(10)),
            prop::option::of(0_u32..20_000),
        )),
    )
        .prop_map(
            |(rid, text, stream, images, image_data, absence_seconds, overrides)| {
                ClientMessage::Message(ClientMessageBody {
                    rid,
                    text,
                    stream,
                    images,
                    image_data,
                    absence_seconds,
                    overrides: overrides.map(|(temperature, top_p, thinking_budget)| {
                        MessageOverrides {
                            temperature,
                            top_p,
                            thinking_budget,
                        }
                    }),
                })
            },
        );

    prop_oneof![
        hello,
        message,
        (prop::option::of(arb_ident()), any::<bool>())
            .prop_map(|(rid, stream)| ClientMessage::Regen(Regen { rid, stream })),
        (prop::option::of(arb_ident()), arb_ident(), arb_json())
            .prop_map(|(rid, name, args)| ClientMessage::Command(Command { rid, name, args }),),
        Just(ClientMessage::Cancel(Cancel {})),
    ]
    .boxed()
}

fn arb_error_code() -> impl Strategy<Value = ErrorCode> {
    prop_oneof![
        Just(ErrorCode::ProtocolError),
        Just(ErrorCode::InvalidRequest),
        Just(ErrorCode::NotFound),
        Just(ErrorCode::Busy),
        Just(ErrorCode::ProviderError),
        Just(ErrorCode::Timeout),
        Just(ErrorCode::InternalError),
    ]
}

fn arb_message_origin() -> impl Strategy<Value = MessageOrigin> {
    prop_oneof![
        Just(MessageOrigin::UserInput),
        Just(MessageOrigin::AssistantReply),
        Just(MessageOrigin::Autonomous),
    ]
}

fn arb_character_info() -> impl Strategy<Value = CharacterInfo> {
    (
        arb_ident(),
        prop::option::of(
            (arb_ident(), arb_small_string())
                .prop_map(|(mime_type, data)| CharacterAvatar { mime_type, data }),
        ),
    )
        .prop_map(|(name, avatar)| CharacterInfo { name, avatar })
}

#[expect(
    clippy::too_many_lines,
    reason = "single server-message strategy keeps variant coverage visible in one property-test generator"
)]
fn arb_server_message() -> BoxedStrategy<ServerMessage> {
    prop_oneof![
        (
            1_u32..3,
            arb_ident(),
            prop::collection::vec(arb_character_info(), 0..3)
        )
            .prop_map(
                |(v, server_name, characters)| ServerMessage::Hello(ServerHello {
                    v,
                    server_name,
                    characters,
                }),
            ),
        (
            prop::option::of(arb_ident()),
            prop::collection::vec(arb_message(), 0..3),
            0_usize..3,
            arb_json(),
            prop::option::of(arb_ident()),
            0_u64..100,
        )
            .prop_map(
                |(rid, messages, active_start, config, selected_character, revision)| {
                    ServerMessage::History(History {
                        rid,
                        messages,
                        active_start,
                        config,
                        selected_character,
                        revision,
                    })
                }
            ),
        Just(ServerMessage::Shutdown(Shutdown {})),
        Just(ServerMessage::Ping(Ping {})),
        (prop::option::of(arb_ident()), arb_ident(), arb_json()).prop_map(|(rid, name, data)| {
            ServerMessage::CommandOutput(CommandOutput { rid, name, data })
        },),
        (
            prop::option::of(arb_ident()),
            arb_error_code(),
            arb_small_string()
        )
            .prop_map(|(rid, code, message)| ServerMessage::Error(Error {
                rid,
                code,
                message
            }),),
        (prop::option::of(arb_ident()), any::<bool>()).prop_map(|(rid, regen)| {
            ServerMessage::StreamStart(StreamStart {
                subagent: None,
                rid,
                regen,
            })
        }),
        (
            prop::option::of(arb_ident()),
            arb_small_string(),
            arb_ident()
        )
            .prop_map(|(rid, text, content_type)| ServerMessage::StreamChunk(
                StreamChunk {
                    subagent: None,
                    rid,
                    text,
                    content_type,
                }
            ),),
        (
            prop::option::of(arb_ident()),
            prop::option::of(arb_ident()),
            prop::option::of(0_u64..100),
            arb_small_string(),
            arb_stream_metadata(),
            arb_ident(),
            any::<bool>(),
        )
            .prop_map(
                |(rid, msg_id, revision, content, metadata, finish_reason, is_final)| {
                    ServerMessage::StreamEnd(StreamEnd {
                        subagent: None,
                        rid,
                        msg_id,
                        revision,
                        content,
                        metadata,
                        finish_reason,
                        is_final,
                    })
                },
            ),
        (
            prop::option::of(arb_ident()),
            arb_ident(),
            prop::option::of(arb_ident())
        )
            .prop_map(|(rid, phase, model)| ServerMessage::Phase(Phase {
                rid,
                phase,
                model
            }),),
        (0_u64..100, prop::option::of(arb_ident()), arb_message()).prop_map(
            |(revision, character, message)| {
                ServerMessage::NewMessage(NewMessage {
                    revision,
                    character,
                    message,
                })
            }
        ),
        (
            prop::option::of(arb_ident()),
            arb_ident(),
            arb_ident(),
            arb_json()
        )
            .prop_map(|(rid, tool_id, tool_name, input)| ServerMessage::ToolCall(
                ToolCall {
                    subagent: None,
                    rid,
                    tool_id,
                    tool_name,
                    input,
                }
            ),),
        (
            prop::option::of(arb_ident()),
            arb_ident(),
            arb_ident(),
            arb_small_string(),
            any::<bool>()
        )
            .prop_map(|(rid, tool_id, tool_name, output, is_error)| {
                ServerMessage::ToolResult(ToolResult {
                    subagent: None,
                    rid,
                    tool_id,
                    tool_name,
                    output,
                    is_error,
                })
            }),
        (
            prop::option::of(arb_ident()),
            arb_small_string(),
            prop::option::of(arb_small_string()),
            prop::option::of(arb_small_string())
        )
            .prop_map(|(rid, path, caption, data)| {
                ServerMessage::SendImage(SendImage {
                    subagent: None,
                    rid,
                    path,
                    caption,
                    data,
                })
            }),
        (0_u32..100_000, arb_small_string()).prop_map(|(expected_tokens, message)| {
            ServerMessage::CacheWarning(CacheWarning {
                expected_tokens,
                message,
            })
        }),
        (
            prop::option::of(arb_ident()),
            arb_ident(),
            arb_ident(),
            arb_ident(),
            arb_ident(),
            prop::option::of(400_u16..600),
            arb_small_string(),
        )
            .prop_map(|(rid, provider, from_key, to_key, kind, status, message)| {
                ServerMessage::ProviderFallbackWarning(ProviderFallbackWarning {
                    rid,
                    provider,
                    from_key,
                    to_key,
                    kind,
                    status,
                    message,
                })
            }),
        (
            prop::option::of(arb_ident()),
            arb_ident(),
            arb_small_string(),
            arb_decimal(1_000),
            arb_decimal(1_000),
            arb_decimal(20),
            prop::collection::vec(arb_decimal(15), 0..3),
            arb_ident(),
            arb_small_string(),
            arb_small_string(),
            arb_small_string(),
            prop::option::of(arb_ident()),
        )
            .prop_map(
                |(
                    rid,
                    budget,
                    message,
                    current_cost,
                    cost_limit,
                    percent_used,
                    crossed_warn_at,
                    period,
                    period_start,
                    reset_at,
                    reset_at_display,
                    scope,
                )| {
                    ServerMessage::UsageWarning(UsageWarning {
                        rid,
                        budget,
                        message,
                        current_cost,
                        cost_limit,
                        percent_used,
                        crossed_warn_at,
                        period,
                        period_start,
                        reset_at,
                        reset_at_display,
                        scope,
                    })
                },
            ),
    ]
    .boxed()
}

fn assert_json_line_round_trip<T>(msg: &T) -> Result<(), TestCaseError>
where
    T: Serialize + DeserializeOwned,
{
    let expected = serde_json::to_value(msg)
        .map_err(|e| TestCaseError::fail(format!("message serializes to JSON: {e}")))?;
    let mut frame = serde_json::to_vec(msg)
        .map_err(|e| TestCaseError::fail(format!("message serializes to bytes: {e}")))?;

    prop_assert!(
        !frame.contains(&b'\n'),
        "JSON payload must not contain a raw frame delimiter"
    );
    frame.push(b'\n');
    prop_assert_eq!(frame.last().copied(), Some(b'\n'), "SWP frame is delimited");

    let Some(line) = frame.strip_suffix(b"\n") else {
        return Err(TestCaseError::fail("frame has delimiter"));
    };
    let parsed: T = serde_json::from_slice(line)
        .map_err(|e| TestCaseError::fail(format!("frame parses: {e}")))?;
    let actual = serde_json::to_value(parsed)
        .map_err(|e| TestCaseError::fail(format!("parsed message serializes: {e}")))?;
    prop_assert_eq!(actual, expected);
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    #[test]
    fn client_messages_round_trip_through_json_line_frames(msg in arb_client_message()) {
        assert_json_line_round_trip(&msg)?;
    }

    #[test]
    fn server_messages_round_trip_through_json_line_frames(msg in arb_server_message()) {
        assert_json_line_round_trip(&msg)?;
    }
}
