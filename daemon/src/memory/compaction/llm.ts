import { shoreLog } from "../../log";

import { buildRequestWithProviderKeys, pushInlineSystem, type ResolvedModel } from "../../llm/request";
import type { ProviderEntry } from "../../llm/credentials";
import type { GenerateResponse, SidecarRequest, WireMessage } from "../../llm/types";
import { describeError } from "../../llm/errors";
import {
  countImageBlocks,
  imageSupportFor,
  isImageRejection,
  recordImageRejection,
  stripImageBlocks,
  textOnlyReason,
} from "../../llm/image_support";
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
  cacheDir: string;
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
    const model = this.#opts.model;
    const support = imageSupportFor(
      {
        ...(model.supports_images === undefined ? {} : { declared: model.supports_images }),
        providerKey: model.provider_key,
        modelId: model.model_id,
      },
      this.#opts.cacheDir,
    );
    if (support === false) this.#dropImages(request);

    try {
      return await this.#send(request);
    } catch (e) {
      if (support === false || !isImageRejection(e) || countImageBlocks(request.messages) === 0) {
        throw CompactionError.llm(describeError(e), e);
      }
      recordImageRejection(this.#opts.cacheDir, model.provider_key, model.model_id);
      this.#dropImages(request);
      try {
        return await this.#send(request);
      } catch (retry) {
        throw CompactionError.llm(describeError(retry), retry);
      }
    }
  }

  async #send(request: SidecarRequest): Promise<GenerateResponse> {
    return await this.#opts.generate(
      request,
      this.#opts.model,
      this.#opts.character,
      this.#opts.emit,
    );
  }

  #dropImages(request: SidecarRequest): void {
    if (countImageBlocks(request.messages) === 0) return;
    const reason = textOnlyReason(this.#opts.model.provider_key, this.#opts.model.model_id);
    const { messages, stripped } = stripImageBlocks(request.messages, reason);
    request.messages = messages;
    shoreLog.warn(
      `shore: dropped ${String(stripped)} image(s) from the compaction request because ${reason}`,
    );
  }
}
