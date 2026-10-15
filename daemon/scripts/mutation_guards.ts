export interface Guard {
  readonly tests: readonly string[];
  readonly functions: readonly string[];
  readonly accepted?: readonly string[];
}

const fns = (file: string, names: readonly string[]): string[] => names.map((name) => `src/${file}:${name}`);

export const GUARDS: readonly Guard[] = [
  {
    tests: ["swp_auth.test.ts"],
    functions: fns("config/token.ts", ["resolveDaemonToken", "tokenMatches"]),
  },
  {
    tests: ["web_transport.test.ts", "web_recovery.test.ts", "web_archives.test.ts", "picture_delivery.test.ts"],
    functions: [
      ...fns("web/auth.ts", ["WebSessions.#presented", "WebSessions.read", "WebSessions.get", "WebSessions.create", "WebSessions.renew", "WebSessions.revoke", "LoginCodes.create", "LoginCodes.redeem"]),
      ...fns("web/policy.ts", ["webBinding", "originHost", "pageOrigin", "readSmallJson"]),
      ...fns("web/server.ts", ["startWebServer"]),
      ...fns("web/recovery.ts", ["sessionDigest", "WebRecovery.constructor", "WebRecovery.sessions"]),
      ...fns("web/archives.ts", ["ArchiveTransfers.#owned", "ArchiveTransfers.upload", "ArchiveTransfers.download"]),
      ...fns("storage/sent_pictures.ts", ["findSentPicture"]),
    ],
  },
  {
    tests: ["swp.test.ts", "swp_transport.test.ts", "swp_local_peer.test.ts", "swp_admission.test.ts", "reliability_boundaries.test.ts"],
    functions: [
      ...fns("swp/framing.ts", ["rustTrim", "WireReader.#fill", "WireReader.readMessage"]),
      ...fns("swp/connection.ts", ["performHandshake", "runMessageLoop"]),
      ...fns("swp/admission.ts", ["admitCapabilities", "admitClientMessage", "uploadArray", "byteLimit"]),
      ...fns("swp/routing.ts", ["eventMatchesSession", "sessionReceives", "threadMatches"]),
    ],
  },
  {
    tests: ["credential_redaction.test.ts", "fallback.test.ts", "config_commands.test.ts"],
    functions: [
      ...fns("llm/redact.ts", ["isCredentialHeader", "redactHeaders", "redactRequest"]),
      ...fns("llm/fallback.ts", ["sanitizeReason", "missingKeyReason", "truncateBytes", "buildWarningMessage", "streamWithCredentialFallback"]),
      ...fns("config/serialize.ts", ["matches", "isSecretConfigPath", "redactSecrets"]),
    ],
  },
  {
    tests: ["subagent.test.ts", "file_tools.test.ts", "bash.test.ts", "create_character.test.ts", "threads.test.ts", "images.test.ts", "browser_media.test.ts"],
    functions: [
      ...fns("tools/workspace_path.ts", ["resolveRoots", "resolvePath", "pathComponents", "isInside", "normalizeWorkspacePath", "normalizePromptVisiblePath"]),
      ...fns("tools/subagent.ts", ["expandPromptMacros", "readPromptFile", "subagentToolSubset"]),
      ...fns("commands/navigation.ts", ["requireUsableCharacterName", "createCharacterAs"]),
      ...fns("engine/threads.ts", ["isValidThreadId", "assertThreadId"]),
      ...fns("handler/images.ts", ["sanitizeFilename", "attachmentFileName", "createAttachmentFile", "ingestUpload"]),
      ...fns("browser/media.ts", ["mediaSource", "imageFilename"]),
    ],
  },
  {
    tests: ["browser_chat.test.ts", "browser_wire.test.ts"],
    functions: fns("browser/markdown.tsx", ["safeHref"]),
  },
  {
    tests: ["file_tools.test.ts"],
    functions: [
      ...fns("tools/edit.ts", ["handleEdit"]),
      ...fns("tools/read.ts", ["handleRead", "readText"]),
      ...fns("tools/file_access.ts", ["openRegularFile", "readBoundedFile"]),
    ],
  },
  {
    tests: ["bash.test.ts", "reliability_execution.test.ts", "workspace_git_push.test.ts"],
    functions: [
      ...fns("tools/bash.ts", ["handleBash"]),
      ...fns("tools/process.ts", ["envWithoutInheritedGitRepo", "runProcess", "boundedProcessOutput"]),
      ...fns("tools/dispatch.ts", ["dispatchWithinDeadline"]),
      ...fns("tools/workspace.ts", ["gitCommitAll", "gitPushWorkspace", "pushLfsObjects"]),
    ],
  },
  {
    tests: ["tool_args_rejected.test.ts"],
    functions: [
      ...fns("llm/tool_args.ts", ["parseToolArgs"]),
      ...fns("tools/validate.ts", ["schemaViolation", "compileToolSchema"]),
      ...fns("tools/execute.ts", ["executeToolUse", "argumentRejection"]),
    ],
  },
  {
    tests: ["mcp.test.ts", "mcp_connect.test.ts", "stream.test.ts"],
    functions: [
      ...fns("mcp/client.ts", ["childEnvironment"]),
      ...fns("notifications.ts", ["expandArgv", "NotificationService.#dispatch"]),
    ],
  },
  {
    tests: ["dotenv.test.ts", "reliability_boundaries.test.ts"],
    functions: fns("config/dotenv.ts", ["parseDotenv", "prepareDotenv", "applyDotenv", "skipExport", "readSingleQuoted", "readDoubleQuoted", "readUnquoted", "readSubstitution", "unescape"]),
  },
  {
    tests: ["config_schema.test.ts", "default_config.test.ts", "app.test.ts"],
    functions: [
      ...fns("config/toml_edit.ts", ["readQuoted", "readKeyPath", "advanceValue", "scanToml", "insertionPoint", "setTomlValue"]),
      ...fns("commands/config.ts", ["restoreConfigFile", "commitConfigKey", "setConfigKey"]),
      ...fns("config/loader.ts", ["createDefaultConfig"]),
    ],
  },
  {
    tests: ["zoned.test.ts", "ledger_budget.test.ts"],
    functions: fns("ledger/zoned.ts", ["naiveInZone", "candidatesFor", "resolveInZone", "partsOf", "daysFromMonday", "atHour", "naiveFrom", "daysInMonth", "toRfc3339", "toZonedRfc3339", "normalizeToZone"]),
  },
  {
    tests: ["budget_gate.test.ts", "ledger_budget.test.ts", "llm_generate.test.ts"],
    functions: [
      ...fns("ledger/gate.ts", ["budgetBlockFor", "costBudgetBlock", "projectedLoopCost"]),
      ...fns("ledger/budget.ts", ["periodWindow", "periodStartNaive", "periodEndNaive", "monthAnchorNaive", "enforceBudgetForCall", "budgetMatchesCall", "shouldBlock", "actionBlocks"]),
    ],
  },
  {
    tests: ["pricing.test.ts"],
    functions: fns("ledger/pricing.ts", ["calculateCost", "cacheWriteOrAnthropicFallback"]),
  },
  {
    tests: ["tool_loop.test.ts", "subagent_loop.test.ts", "generic_loop.test.ts", "claude_agent_loop.test.ts"],
    functions: [
      ...fns("engine/tool_loop.ts", ["runToolLoop"]),
      ...fns("tools/subagent_loop.ts", ["nestedContext"]),
      ...fns("llm/providers/generic_loop.ts", ["genericToolLoopEvents"]),
    ],
  },
  {
    tests: ["keepalive_service.test.ts", "keepalive_rewrite.test.ts", "keepalive_wiring.test.ts", "keepalive_heartbeat.test.ts", "cache_keepalive.test.ts", "cache_scenarios.test.ts"],
    functions: [
      ...fns("cache/keepalive.ts", ["prefixIsStale", "pingLandedCold", "pingRewrotePrefix", "buildKeepalivePing", "KeepaliveService.#haltModel", "KeepaliveService.arm", "KeepaliveService.disarm", "KeepaliveService.observe", "KeepaliveService.tick", "KeepaliveService.#ping", "KeepaliveService.#pingInner", "KeepaliveService.#skip", "readsFromMissedModel"]),
      ...fns("cache/schedule.ts", ["retryDelay", "CacheKeepalive.#deadline", "CacheKeepalive.setInterval", "CacheKeepalive.onCacheWarmed", "CacheKeepalive.onPingSucceeded", "CacheKeepalive.onCacheInvalidated", "CacheKeepalive.tick", "CacheKeepalive.onPingFailed"]),
    ],
  },
  {
    tests: ["anthropic_adapter.test.ts", "chat_wire_contract.test.ts", "cache_scenarios.test.ts", "mock_anthropic.test.ts", "continuation_placement.test.ts", "anthropic_thinking_verification.test.ts"],
    functions: [
      ...fns("llm/providers/anthropic.ts", ["anthropicContentEvents", "normalizeMessages", "placeBreakpoints", "clearCacheMarkers", "applyDefaultPlacement", "placeContinuationBreakpoints", "applyMessageBreakpoint", "dropUnverifiableThinking", "toContentBlockParam", "clampEnabledBudget", "buildThinkingParams"]),
      ...fns("llm/cache_placement.ts", ["assistantTurnStart", "frozenBoundaryBefore", "messageBreakpoints"]),
    ],
  },
  {
    tests: ["replay.test.ts", "chat_wire_contract.test.ts", "sanitize.test.ts"],
    functions: [
      ...fns("llm/replay.ts", ["carriesOpaqueData", "hasForeignCarrier", "mintedByTheActiveModel", "replayableMessagesWithDrops"]),
      ...fns("llm/sanitize.ts", ["sanitizeToolPairs"]),
    ],
  },
  {
    tests: ["gemini_adapter.test.ts", "zai_adapter.test.ts", "vercel_adapter.test.ts", "openai_stream.test.ts", "openrouter_conversion.test.ts", "image_blocks.test.ts", "tool_defs.test.ts", "nanogpt_prompt_caching.test.ts"],
    functions: [
      ...fns("llm/providers/gemini.ts", ["geminiStreamEvents", "translateMessages", "translateParts", "mergeConsecutiveRoles"]),
      ...fns("llm/providers/zai.ts", ["buildZaiMessages", "turnToZai", "zaiStreamEvents"]),
      ...fns("llm/providers/vercel.ts", ["buildMessages", "turnToVercel"]),
      ...fns("llm/providers/openai.ts", ["openAIStreamEvents", "applyPromptCaching", "turnToOpenAI"]),
    ],
  },
  {
    tests: ["claude_agent_injected_context.test.ts", "claude_agent_stream.test.ts", "claude_agent_tools.test.ts", "claude_agent_loop.test.ts"],
    functions: [
      ...fns("llm/providers/claude_agent_injections.ts", ["injectedKind", "canHoldCacheControl", "isBillingHeader", "filterInjectedContext"]),
      ...fns("llm/providers/claude_agent.ts", ["claudeAgentEnvironment", "buildOptions"]),
      ...fns("llm/providers/claude_agent_tools.ts", ["sanitize", "ToolNames.constructor", "ToolNames.bareOf", "underCeiling", "toCallToolResult", "shoreToolServer"]),
    ],
  },
  {
    tests: ["abort_not_retried.test.ts", "llm_decisions.test.ts", "retry_after.test.ts", "request.test.ts"],
    functions: [
      ...fns("llm/abort.ts", ["isAbortError"]),
      ...fns("llm/retry.ts", ["shouldRetryError"]),
      ...fns("llm/fallback.ts", ["retryDelayMs", "sleepUnlessAborted", "streamWithRetry", "retryAfterHint"]),
      ...fns("llm/retry_after.ts", ["parseRetryAfterMs", "retryAfterMsFromError"]),
      ...fns("llm/request.ts", ["buildRequestWithProviderKeys"]),
    ],
  },
  {
    tests: ["image_reduction.test.ts", "image_tokens.test.ts", "image_support.test.ts", "image_dimensions.test.ts"],
    functions: [
      ...fns("llm/prepare_images.ts", ["planReduction", "encodeWithin", "limitImageBlock", "limitRequestImages"]),
      ...fns("llm/image_tokens.ts", ["visualTokens", "sizeForTier", "fitLongEdge"]),
      ...fns("llm/image_support.ts", ["capRequestImages"]),
      ...fns("llm/image_dimensions.ts", ["png", "gif", "webp", "jpeg", "isStartOfFrame"]),
    ],
  },
  {
    tests: ["embeds.test.ts"],
    functions: fns("engine/embeds.ts", ["wikilink", "escaped", "localTarget", "splitText", "embedsIn", "unsentNotice", "pictureText"]),
  },
  {
    tests: ["message_store_transactions.test.ts", "conversation_durability.test.ts", "conversation.test.ts", "characters.test.ts", "turn.test.ts"],
    functions: [
      ...fns("engine/message_store.ts", ["withoutOrphanToolResults", "unansweredTailToolUseIds", "MessageStore.loadWithRaw", "MessageStore.recoverInterruptedToolLoop", "MessageStore.#mutate", "MessageStore.#enqueue", "MessageStore.#persist"]),
      ...fns("engine/backup.ts", ["backupBeforeWrite", "pruneBackups", "quarantineLines"]),
      ...fns("commands/conversation.ts", ["deleteMessages"]),
      ...fns("handler/turn.ts", ["appendUserTurn"]),
    ],
  },
  {
    tests: ["data_directory_lease.test.ts"],
    functions: fns("daemon/data_directory_lease.ts", ["acquireDataDirectoryLease", "takeDataDirectoryProcessLock", "ownerProcessState", "createLeaseFile", "leaseFor", "readSnapshot", "removeSnapshot", "parseOwner"]),
  },
  {
    tests: ["snapshot_gate.test.ts"],
    functions: fns("snapshot_gate.ts", ["SnapshotGate.withActivity", "SnapshotGate.withSnapshot", "SnapshotGate.#acquire", "SnapshotGate.#drain"]),
  },
  {
    tests: ["archive.test.ts", "supported_baseline.test.ts", "delete_character.test.ts", "storage_archive.test.ts"],
    functions: [
      ...fns("commands/archive.ts", ["exportCharacter", "importCharacter", "deleteCharacter", "deletionTargets", "contains", "extractArchive", "readManifest", "installCharacter"]),
      ...fns("storage/archive.ts", ["exportUnifiedDatabase", "importUnifiedDatabase", "removeStoredCharacter"]),
    ],
  },
  {
    tests: ["storage_retention.test.ts", "agent_session_retention.test.ts"],
    functions: [
      ...fns("storage/retention.ts", ["pruneDiagnostics"]),
      ...fns("llm/providers/agent_session_retention.ts", ["sessionReferences", "retireSession", "reconcileSessions", "removeLocalSession", "pruneSdkSessions"]),
    ],
  },
  {
    tests: ["workspace_turns.test.ts", "workspace_rewind_commands.test.ts", "generation.test.ts"],
    functions: [
      ...fns("tools/workspace_turns.ts", ["replyVersions", "recordTurn", "undoTurns", "redoTurns", "aliasTurn", "pruneTurns", "replay", "isComplete", "move"]),
      ...fns("commands/conversation.ts", ["rewindDeleted"]),
    ],
  },
  {
    tests: ["thread_fork.test.ts", "registry_threads.test.ts"],
    functions: [
      ...fns("engine/fork.ts", ["selectForkContext", "withForkLock", "forkThreadLocked", "loadForkSource", "recoverForks"]),
      ...fns("engine/threads.ts", ["writeThreadsIndex", "createThread"]),
      ...fns("characters.ts", ["CharacterRegistry.createThread", "CharacterRegistry.archiveThread", "CharacterRegistry.#withThreadIndex"]),
    ],
  },
  {
    tests: ["compaction_truncated.test.ts", "compaction_resume.test.ts", "archive_writer.test.ts", "history_store.test.ts"],
    functions: [
      ...fns("memory/compaction/manager.ts", ["rollbackCompaction", "compact", "archiveCompactPrefix", "recoverArchivedPass", "resolveCheckpoint", "discardCheckpoint", "adoptOutsideEdits", "stillAsWritten"]),
      ...fns("memory/compaction/archive.ts", ["archiveAndRetain", "archiveToDatabase"]),
      ...fns("engine/history_store.ts", ["HistoryStore.beginCompaction", "HistoryStore.finishCompaction", "HistoryStore.abortCompaction", "HistoryStore.recoverPending"]),
    ],
  },
  {
    tests: ["heartbeat.test.ts"],
    functions: fns("autonomy/heartbeat.ts", ["HeartbeatClock.#isAbandoned", "HeartbeatClock.tick", "HeartbeatClock.#bounded", "HeartbeatClock.schedule", "HeartbeatClock.onUserMessage", "HeartbeatClock.boundWake"]),
  },
  {
    tests: ["router.test.ts", "reliability_lifecycle.test.ts"],
    functions: [
      ...fns("handler/router.ts", ["cancelledStreamEnd", "MessageHandler.enqueueRouted", "MessageHandler.handleControl", "MessageHandler.#cancel", "MessageHandler.launchGeneration", "MessageHandler.cancelGeneration"]),
      ...fns("commands/segments.ts", ["clear"]),
    ],
  },
  {
    tests: ["daemon_run.test.ts"],
    functions: fns("daemon/run.ts", ["startDaemon", "exitIfStillRunning", "bounded"]),
  },
  {
    tests: ["operation_contracts.test.ts"],
    functions: fns("operations/contracts.ts", ["check", "parseOperationInput", "parseOperationResult", "assertContractBindings"]),
  },
];
