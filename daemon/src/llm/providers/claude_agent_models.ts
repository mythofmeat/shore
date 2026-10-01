import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { toRfc3339 } from "../../ledger/zoned.ts";
import type { DiscoveredModel, DiscoveryResult } from "../discovery.ts";
import { claudeAgentEnvironment } from "./claude_agent.ts";
import { claudeCodeLaunchFailure, claudeCodeOptions } from "./claude_code.ts";

export type ClaudeAgentModelQuery = (params: Parameters<typeof query>[0]) => Pick<Query, "supportedModels" | "close">;

export async function discoverClaudeAgent(
  providerKey: string,
  baseUrl?: string,
  runQuery: ClaudeAgentModelQuery = query,
): Promise<DiscoveryResult<DiscoveredModel[]>> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30_000);
  timeout.unref();
  let session: ReturnType<ClaudeAgentModelQuery> | undefined;
  try {
    session = runQuery({
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {})(),
      options: {
        cwd: tmpdir(), env: claudeAgentEnvironment(baseUrl), ...claudeCodeOptions(), abortController,
        settingSources: [], strictMcpConfig: true, tools: [], skills: [],
        persistSession: false,
      },
    });
    const models = await session.supportedModels();
    const discoveredAt = toRfc3339(Date.now());
    return { ok: models.map(model => ({
      provider_key: providerKey,
      model_id: model.value,
      display_name: model.displayName,
      description: model.description,
      sdk: "claude_agent",
      ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
      support: {
        ...(model.supportsEffort === undefined && model.supportedEffortLevels === undefined ? {} : {
          effort: { supported: model.supportsEffort !== false, levels: model.supportedEffortLevels ?? [] },
        }),
        ...(model.supportsAdaptiveThinking === undefined ? {} : {
          thinking: { adaptive: model.supportsAdaptiveThinking },
        }),
      },
      raw_provider_metadata: model,
      discovered_at: discoveredAt,
    })) };
  } catch (e) {
    const failure = claudeCodeLaunchFailure(e) ?? e;
    return { err: { kind: "network", provider: providerKey, message: failure instanceof Error ? failure.message : String(failure) } };
  } finally {
    clearTimeout(timeout);
    session?.close();
  }
}
