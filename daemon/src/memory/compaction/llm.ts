import { buildRequestWithProviderKeys, pushInlineSystem, type ResolvedModel } from "../../llm/request";
import type { ProviderEntry } from "../../llm/credentials";
import type { GenerateResponse, SidecarRequest, WireMessage } from "../../llm/types";
import { describeError } from "../../llm/errors";
import type { FrameSink } from "../../llm/stream";
import { CompactionError, type CompactionLlm } from "./types";

export const COMPACTION_TAIL_ENTRY_COUNT = 2;

export function appendCompactionTail(
  request: SidecarRequest,
  userPrompt: WireMessage,
  systemPrompt: string,
): void {
  request.messages.push(userPrompt);
  pushInlineSystem(request, systemPrompt);
}

export type LedgerGenerate = (
  request: SidecarRequest,
  model: ResolvedModel,
  character: string,
  sink?: FrameSink,
) => Promise<GenerateResponse>;

export interface RealCompactionLlmOptions {
  model: ResolvedModel;
  providerEntry?: ProviderEntry;
  character: string;
  generate: LedgerGenerate;
  env?: NodeJS.ProcessEnv;
  emit?: FrameSink;
}

export class RealCompactionLlm implements CompactionLlm {
  readonly #opts: RealCompactionLlmOptions;

  constructor(opts: RealCompactionLlmOptions) {
    this.#opts = opts;
  }

  buildInitialRequest(
    system: string,
    compactNowUser: WireMessage,
    chatRequest: SidecarRequest,
  ): SidecarRequest {
    let built;
    try {
      built = buildRequestWithProviderKeys(
        this.#opts.model,
        this.#opts.providerEntry,
        {
          messages: [...chatRequest.messages],
          ...(chatRequest.system === undefined ? {} : { system: chatRequest.system }),
          ...(chatRequest.tools === undefined ? {} : { tools: chatRequest.tools }),
          replay: chatRequest.replay_prior_thinking,
        },
        this.#opts.env,
      );
    } catch (e) {
      throw CompactionError.llm((e as Error).message);
    }

    const request = built.request;
    appendCompactionTail(request, compactNowUser, system);
    return request;
  }

  async generate(request: SidecarRequest): Promise<GenerateResponse> {
    try {
      return await this.#opts.generate(
        request,
        this.#opts.model,
        this.#opts.character,
        this.#opts.emit,
      );
    } catch (e) {
      throw CompactionError.llm(describeError(e), e);
    }
  }
}
