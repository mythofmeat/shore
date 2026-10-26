export interface Guard {
  readonly tests: readonly string[];
  readonly functions: readonly string[];
  readonly floor: number;
}

const fns = (file: string, names: readonly string[]): string[] => names.map((name) => `src/${file}:${name}`);

export const GUARDS: readonly Guard[] = [
  {
    tests: ["swp_auth.test.ts"],
    floor: 0.8,
    functions: fns("config/token.ts", ["resolveDaemonToken", "tokenMatches"]),
  },
  {
    tests: ["web.test.ts", "sign_in.test.ts"],
    floor: 0.8,
    functions: [
      ...fns("web/auth.ts", ["WebSessions.#presented", "WebSessions.read", "WebSessions.get", "WebSessions.create", "WebSessions.renew", "WebSessions.revoke", "LoginCodes.create", "LoginCodes.redeem"]),
      ...fns("web/policy.ts", ["originHost", "pageOrigin", "readSmallJson"]),
      ...fns("web/recovery.ts", ["sessionDigest", "WebRecovery.constructor", "WebRecovery.sessions"]),
      ...fns("web/archives.ts", ["ArchiveTransfers.#owned"]),
      ...fns("storage/sent_pictures.ts", ["findSentPicture"]),
    ],
  },
  {
    tests: ["swp.test.ts", "reliability.test.ts"],
    floor: 0.85,
    functions: [
      ...fns("swp/framing.ts", ["rustTrim", "WireReader.#fill", "WireReader.readMessage"]),
      ...fns("swp/admission.ts", ["admitCapabilities", "admitClientMessage", "uploadArray", "byteLimit"]),
      ...fns("swp/routing.ts", ["eventMatchesSession", "threadMatches"]),
    ],
  },
  {
    tests: ["credential_redaction.test.ts", "fallback.test.ts", "config_commands.test.ts"],
    floor: 0.8,
    functions: [
      ...fns("llm/redact.ts", ["isCredentialHeader", "redactHeaders", "redactRequest"]),
      ...fns("llm/fallback.ts", ["missingKeyReason"]),
      ...fns("config/serialize.ts", ["matches", "isSecretConfigPath", "redactSecrets"]),
    ],
  },
  {
    tests: ["subagent.test.ts", "file_tools.test.ts", "bash.test.ts", "create_character.test.ts", "threads.test.ts", "images.test.ts", "browser.test.ts"],
    floor: 0.8,
    functions: [
      ...fns("tools/workspace_path.ts", ["resolveRoots", "resolvePath", "pathComponents", "isInside"]),
      ...fns("tools/subagent.ts", ["expandPromptMacros", "readPromptFile", "subagentToolSubset"]),
      ...fns("commands/navigation.ts", ["requireUsableCharacterName"]),
      ...fns("engine/threads.ts", ["isValidThreadId", "assertThreadId"]),
      ...fns("handler/images.ts", ["sanitizeFilename", "saveAttachment", "ingestUpload"]),
      ...fns("browser/media.ts", ["mediaSource", "imageFilename"]),
    ],
  },
  {
    tests: ["browser.test.ts"],
    floor: 0.95,
    functions: fns("browser/markdown.tsx", ["safeHref"]),
  },
  {
    tests: ["file_tools.test.ts"],
    floor: 0.6,
    functions: [
      ...fns("tools/edit.ts", ["handleEdit"]),
    ],
  },
  {
    tests: ["bash.test.ts", "reliability.test.ts", "workspace_git_push.test.ts"],
    floor: 0.55,
    functions: [
      ...fns("tools/process.ts", ["envWithoutInheritedGitRepo", "runProcess", "boundedProcessOutput"]),
    ],
  },
  {
    tests: ["isolation.test.ts"],
    floor: 0.9,
    functions: [
      ...fns("tools/character_user.ts", ["setprivArgs", "runsWithNoNewPrivs"]),
      ...fns("tools/character_workspace.ts", ["warnIfNoNewPrivsInherited", "toolsOnDisk"]),
    ],
  },
  {
    tests: ["tool_args_rejected.test.ts"],
    floor: 0.7,
    functions: [
      ...fns("llm/tool_args.ts", ["parseToolArgs"]),
      ...fns("tools/execute.ts", ["executeToolUse", "argumentRejection"]),
    ],
  },
  {
    tests: ["mcp.test.ts", "mcp_connect.test.ts", "stream.test.ts"],
    floor: 0.85,
    functions: [
      ...fns("mcp/client.ts", ["childEnvironment"]),
      ...fns("notifications.ts", ["expandArgv"]),
    ],
  },
  {
    tests: ["dotenv.test.ts", "reliability.test.ts"],
    floor: 0.75,
    functions: fns("config/dotenv.ts", ["parseDotenv", "applyDotenv"]),
  },
  {
    tests: ["config_schema.test.ts", "default_config.test.ts", "app.test.ts"],
    floor: 0.45,
    functions: [
      ...fns("config/toml_edit.ts", ["readQuoted", "readKeyPath", "advanceValue", "scanToml", "insertionPoint", "setTomlValue"]),
      ...fns("commands/config.ts", ["restoreConfigFile", "commitConfigKey", "setConfigKey"]),
    ],
  },
  {
    tests: ["zoned.test.ts", "ledger_budget.test.ts"],
    floor: 0.7,
    functions: fns("ledger/zoned.ts", ["naiveInZone", "candidatesFor", "resolveInZone", "partsOf", "daysFromMonday", "atHour", "naiveFrom", "daysInMonth", "toRfc3339", "toZonedRfc3339", "normalizeToZone"]),
  },
  {
    tests: ["budget_gate.test.ts", "ledger_budget.test.ts", "llm_generate.test.ts"],
    floor: 0.75,
    functions: [
      ...fns("ledger/gate.ts", ["budgetBlockFor", "costBudgetBlock", "projectedLoopCost"]),
      ...fns("ledger/budget.ts", ["periodWindow", "periodStartNaive", "periodEndNaive", "monthAnchorNaive", "budgetMatchesCall", "shouldBlock", "actionBlocks"]),
    ],
  },
  {
    tests: ["pricing.test.ts"],
    floor: 0.95,
    functions: fns("ledger/pricing.ts", ["calculateCost"]),
  },
  {
    tests: ["tool_loop.test.ts", "subagent_loop.test.ts", "generic_loop.test.ts", "claude_agent_loop.test.ts"],
    floor: 0.85,
    functions: [
      ...fns("engine/tool_loop.ts", ["runToolLoop"]),
      ...fns("tools/subagent_loop.ts", ["nestedContext"]),
    ],
  },
  {
    tests: ["keepalive.test.ts", "keepalive_wiring.test.ts", "keepalive_heartbeat.test.ts", "cache_scenarios.test.ts"],
    floor: 0.6,
    functions: [
      ...fns("cache/keepalive.ts", ["prefixIsStale", "pingLandedCold", "buildKeepalivePing", "KeepaliveService.#haltModel", "KeepaliveService.arm", "KeepaliveService.observe", "KeepaliveService.tick", "KeepaliveService.#ping", "KeepaliveService.#pingInner", "KeepaliveService.#skip"]),
      ...fns("cache/schedule.ts", ["retryDelay", "CacheKeepalive.#deadline", "CacheKeepalive.setInterval", "CacheKeepalive.onCacheWarmed", "CacheKeepalive.onPingSucceeded", "CacheKeepalive.onCacheInvalidated", "CacheKeepalive.tick", "CacheKeepalive.onPingFailed"]),
    ],
  },
  {
    tests: ["anthropic_adapter.test.ts", "chat_wire_contract.test.ts", "cache_scenarios.test.ts", "continuation_placement.test.ts", "anthropic_thinking_verification.test.ts"],
    floor: 0.6,
    functions: [
      ...fns("llm/providers/anthropic.ts", ["anthropicContentEvents", "normalizeMessages", "placeBreakpoints", "clearCacheMarkers", "applyDefaultPlacement", "placeContinuationBreakpoints", "applyMessageBreakpoint", "dropUnverifiableThinking", "toContentBlockParam", "clampEnabledBudget", "buildThinkingParams"]),
      ...fns("llm/cache_placement.ts", ["assistantTurnStart", "frozenBoundaryBefore", "messageBreakpoints"]),
    ],
  },
  {
    tests: ["replay.test.ts", "chat_wire_contract.test.ts", "sanitize.test.ts"],
    floor: 0.65,
    functions: [
      ...fns("llm/replay.ts", ["carriesOpaqueData", "hasForeignCarrier", "mintedByTheActiveModel", "replayableMessagesWithDrops"]),
      ...fns("llm/sanitize.ts", ["sanitizeToolPairs"]),
    ],
  },
  {
    tests: ["gemini_adapter.test.ts", "zai_adapter.test.ts", "vercel_adapter.test.ts", "openai.test.ts", "openrouter_conversion.test.ts", "image_blocks.test.ts", "tool_defs.test.ts"],
    floor: 0.5,
    functions: [
      ...fns("llm/providers/gemini.ts", ["geminiStreamEvents", "translateMessages", "translateParts", "mergeConsecutiveRoles"]),
      ...fns("llm/providers/zai.ts", ["buildZaiMessages", "turnToZai", "zaiStreamEvents"]),
      ...fns("llm/providers/vercel.ts", ["buildMessages", "turnToVercel"]),
      ...fns("llm/providers/openai.ts", ["openAIStreamEvents", "applyPromptCaching", "turnToOpenAI"]),
    ],
  },
  {
    tests: ["claude_agent_injected_context.test.ts", "claude_agent_stream.test.ts", "claude_agent_tools.test.ts", "claude_agent_loop.test.ts"],
    floor: 0.65,
    functions: [
      ...fns("llm/providers/claude_agent_injections.ts", ["injectedKind", "canHoldCacheControl", "isBillingHeader", "filterInjectedContext"]),
      ...fns("llm/providers/claude_agent.ts", ["claudeAgentEnvironment", "buildOptions"]),
      ...fns("llm/providers/claude_agent_tools.ts", ["sanitize", "ToolNames.constructor", "ToolNames.bareOf", "toCallToolResult", "shoreToolServer"]),
    ],
  },
  {
    tests: ["abort_not_retried.test.ts", "llm_decisions.test.ts", "retry_after.test.ts", "request.test.ts"],
    floor: 0.55,
    functions: [
      ...fns("llm/abort.ts", ["isAbortError"]),
      ...fns("llm/retry.ts", ["shouldRetryError"]),
      ...fns("llm/fallback.ts", ["retryDelayMs", "sleepUnlessAborted", "streamWithRetry", "retryAfterHint"]),
      ...fns("llm/retry_after.ts", ["parseRetryAfterMs", "retryAfterMsFromError"]),
      ...fns("llm/request.ts", ["buildRequestWithProviderKeys"]),
    ],
  },
  {
    tests: ["image_limits.test.ts", "image_dimensions.test.ts"],
    floor: 0.6,
    functions: [
      ...fns("llm/prepare_images.ts", ["planReduction", "encodeWithin", "limitImageBlock", "limitRequestImages"]),
      ...fns("llm/image_tokens.ts", ["visualTokens", "sizeForTier", "fitLongEdge"]),
      ...fns("llm/image_support.ts", ["capRequestImages"]),
      ...fns("llm/image_dimensions.ts", ["png", "gif", "webp", "jpeg", "isStartOfFrame"]),
    ],
  },
  {
    tests: ["embeds.test.ts"],
    floor: 0.8,
    functions: fns("engine/embeds.ts", ["wikilink", "escaped", "localTarget", "splitText", "embedsIn", "unsentNotice", "pictureText"]),
  },
  {
    tests: ["message_store_transactions.test.ts", "conversation_durability.test.ts", "conversation.test.ts", "characters.test.ts", "turn.test.ts"],
    floor: 0.6,
    functions: [
      ...fns("engine/message_store.ts", ["withoutOrphanToolResults", "unansweredTailToolUseIds", "MessageStore.loadWithRaw", "MessageStore.recoverInterruptedToolLoop", "MessageStore.#mutate", "MessageStore.#enqueue", "MessageStore.#persist"]),
      ...fns("engine/backup.ts", ["backupBeforeWrite", "pruneBackups", "quarantineLines"]),
      ...fns("commands/conversation.ts", ["deleteMessages"]),
      ...fns("handler/turn.ts", ["appendUserTurn"]),
    ],
  },
  {
    tests: ["data_directory.test.ts"],
    floor: 0.55,
    functions: fns("daemon/data_directory_lease.ts", ["acquireDataDirectoryLease", "takeDataDirectoryProcessLock", "ownerProcessState", "createLeaseFile", "leaseFor", "readSnapshot", "removeSnapshot", "parseOwner"]),
  },
  {
    tests: ["snapshot_gate.test.ts"],
    floor: 0.8,
    functions: fns("snapshot_gate.ts", ["SnapshotGate.withActivity", "SnapshotGate.withSnapshot", "SnapshotGate.#acquire", "SnapshotGate.#drain"]),
  },
  {
    tests: ["archive.test.ts", "supported_baseline.test.ts", "delete_character.test.ts", "storage_archive.test.ts"],
    floor: 0.55,
    functions: [
      ...fns("commands/archive.ts", ["exportCharacter", "importCharacter", "deleteCharacter", "deletionTargets", "extractArchive", "readManifest", "installCharacter"]),
      ...fns("storage/archive.ts", ["exportUnifiedDatabase", "importUnifiedDatabase", "removeStoredCharacter"]),
    ],
  },
  {
    tests: ["retention.test.ts"],
    floor: 0.45,
    functions: [
      ...fns("storage/retention.ts", ["pruneDiagnostics"]),
      ...fns("llm/providers/agent_session_retention.ts", ["sessionReferences", "retireSession", "reconcileSessions", "removeLocalSession", "pruneSdkSessions"]),
    ],
  },
  {
    tests: ["workspace_turns.test.ts", "workspace_rewind_commands.test.ts", "generation.test.ts"],
    floor: 0.75,
    functions: [
      ...fns("tools/workspace_turns.ts", ["replyVersions", "recordTurn", "undoTurns", "redoTurns", "aliasTurn", "pruneTurns", "replay", "isComplete", "move"]),
      ...fns("commands/conversation.ts", ["rewindDeleted"]),
    ],
  },
  {
    tests: ["threads.test.ts"],
    floor: 0.5,
    functions: [
      ...fns("engine/fork.ts", ["selectForkContext", "withForkLock", "forkThreadLocked", "loadForkSource", "recoverForks"]),
      ...fns("engine/threads.ts", ["writeThreadsIndex", "createThread"]),
      ...fns("characters.ts", ["CharacterRegistry.createThread", "CharacterRegistry.archiveThread", "CharacterRegistry.#withThreadIndex"]),
    ],
  },
  {
    tests: ["compaction_truncated.test.ts", "compaction_resume.test.ts", "archive_writer.test.ts", "history_store.test.ts"],
    floor: 0.55,
    functions: [
      ...fns("memory/compaction/manager.ts", ["rollbackCompaction", "archiveCompactPrefix", "recoverArchivedPass", "resolveCheckpoint"]),
      ...fns("memory/compaction/archive.ts", ["archiveAndRetain", "archiveToDatabase"]),
      ...fns("engine/history_store.ts", ["HistoryStore.beginCompaction", "HistoryStore.finishCompaction", "HistoryStore.abortCompaction", "HistoryStore.recoverPending"]),
    ],
  },
  {
    tests: ["heartbeat.test.ts"],
    floor: 0.75,
    functions: fns("autonomy/heartbeat.ts", ["HeartbeatClock.#isAbandoned", "HeartbeatClock.tick", "HeartbeatClock.#bounded", "HeartbeatClock.schedule", "HeartbeatClock.onUserMessage"]),
  },
  {
    tests: ["router.test.ts", "reliability.test.ts"],
    floor: 0.2,
    functions: [
      ...fns("handler/router.ts", ["cancelledStreamEnd"]),
    ],
  },
  {
    tests: ["daemon_run.test.ts"],
    floor: 0.95,
    functions: fns("daemon/run.ts", ["exitIfStillRunning"]),
  },
  {
    tests: ["operation_contracts.test.ts"],
    floor: 0.8,
    functions: fns("operations/contracts.ts", ["check", "parseOperationInput", "parseOperationResult", "assertContractBindings"]),
  },
];

export const CLIENT_FLOORS: Readonly<Record<string, number>> = {
  "shore-cli/src/cli.rs": 0.75,
  "shore-cli/src/output/config.rs": 0.7,
  "shore-cli/src/run.rs": 0.8,
  "shore-cli/src/tui/ansi.rs": 0.6,
  "shore-cli/src/tui/app/input.rs": 0.65,
  "shore-cli/src/tui/clipboard.rs": 0.95,
  "shore-cli/src/tui/draft.rs": 0.65,
  "shore-cli/src/tui/input.rs": 0.5,
  "shore-cli/src/tui/keymap.rs": 0.85,
  "shore-cli/src/tui/mod.rs": 0.45,
  "shore-common/src/active_character.rs": 0.95,
  "shore-common/src/dirs.rs": 0.95,
  "shore-common/src/protocol/types.rs": 0.45,
  "shore-common/src/swp_client/conn_manager.rs": 0.5,
  "shore-common/src/swp_client/connection.rs": 0.75,
  "shore-common/src/swp_client/discovery.rs": 0.95,
  "shore-common/src/swp_client/sync.rs": 0.95,
  "shore-common/src/token.rs": 0.95,
};
