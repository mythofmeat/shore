import { CharacterConfigError } from "../characters.ts";
import { isTimeoutError } from "../llm/abort.ts";
import { describeError, toLlmError } from "../llm/errors.ts";
import { retryAfterHint } from "../llm/fallback.ts";
import type { ClientMessage } from "../protocol/ClientMessage.ts";
import type { Command } from "../protocol/Command.ts";
import type { ErrorCode } from "../protocol/ErrorCode.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import { ImagesUnsupportedError, NoModelError } from "./setup.ts";
import type {
  DirectSender,
  ControlRoutedMessage,
  RequestMeta,
  RoutedMessage,
  SessionRouter,
} from "../swp/session.ts";
import type { LeaseRouter, StreamLeases } from "./lease.ts";

const RID_BEARING: ReadonlySet<string> = new Set([
  "history",
  "command_output",
  "error",
  "stream_start",
  "stream_chunk",
  "stream_end",
  "phase",
  "tool_call",
  "tool_result",
  "send_image",
  "provider_fallback_warning",
  "usage_warning",
]);

function generationErrorCode(error: unknown): ErrorCode {
  if (
    error instanceof NoModelError ||
    error instanceof CharacterConfigError ||
    error instanceof ImagesUnsupportedError
  ) {
    return error.code;
  }
  const llmError = toLlmError(error);
  if (isTimeoutError(error) || (llmError.kind === "stream_errored" && llmError.timeout === true)) {
    return "timeout";
  }
  if (
    llmError.kind === "http_status" ||
    llmError.kind === "provider" ||
    llmError.kind === "stream_errored"
  ) {
    return "provider_error";
  }
  return "internal_error";
}

export function withRid(msg: ServerMessage, rid: string | null): ServerMessage {
  if (rid === null || !RID_BEARING.has(msg.type)) return msg;
  return { ...msg, rid } as ServerMessage;
}

function cancelledStreamEnd(rid: string | null): ServerMessage {
  return withRid(
    {
      type: "stream_end",
      content: "",
      metadata: {
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        timing: { total_ms: 0, ttft_ms: 0 },
        model: "",
      },
      finish_reason: "cancelled",
      is_final: true,
    },
    rid,
  );
}

export interface HandlerRegistry {
  resolveCharacter(selected: string | null): { name: string } | { error: string };
}

export type RunGeneration = (params: GenerationParams) => Promise<void>;

export interface GenerationParams {
  readonly meta: RequestMeta;
  readonly body: EngineBody;
  readonly regen: boolean;
  readonly charName: string;
  readonly rid: string | null;
  readonly send: DirectSender;
  readonly signal: AbortSignal;
}

export interface EngineBody {
  readonly rid: string | null;
  readonly text: string;
  readonly stream: boolean;
  readonly images: readonly string[];
  readonly image_data: readonly unknown[];
  readonly absence_seconds?: number | null;
  readonly guidance?: string;
}

export interface HandlerNotifier {
  notify(event: "error", title: string, body: string): void;
}

export interface MessageHandlerDeps {
  readonly router: SessionRouter & LeaseRouter;
  readonly leases: StreamLeases;
  readonly registry: HandlerRegistry;
  readonly notifier: HandlerNotifier;
  readonly dispatchCommand: (cmd: Command, meta: RequestMeta) => Promise<ServerMessage>;
  readonly runGeneration: RunGeneration;
  readonly log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void;
    error?: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export function sanitiseRid(rid: string | null | undefined): string | null {
  if (rid === undefined || rid === null) return null;
  for (const ch of rid) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7f || code === 0) return null;
  }
  return rid;
}

export class MessageHandler {
  readonly #deps: MessageHandlerDeps;
  readonly #sessions = new Map<number, () => void>();

  constructor(deps: MessageHandlerDeps) {
    this.#deps = deps;
  }

  get sessionStateCount(): number {
    return this.#sessions.size;
  }

  async run(routes: AsyncIterable<RoutedMessage>): Promise<void> {
    this.#deps.log?.info?.("message handler started");
    for await (const routed of routes) {
      await this.handleRouted(routed);
    }
    await this.drain();
    this.#deps.log?.info?.("message handler shutting down (route stream closed)");
  }

  async handleRouted(routed: RoutedMessage): Promise<void> {
    switch (routed.kind) {
      case "command": {
        const result = await this.#deps.dispatchCommand(routed.cmd, routed.meta);
        await this.#deps.router.sendToSession(routed.meta.session.sessionId, result);
        return;
      }
      case "engine":
        await this.handleEngine(routed.msg, routed.meta);
        return;
      case "all_clients_disconnected": {
        await this.handleControl(routed);
      }
    }
  }

  async handleControl(routed: ControlRoutedMessage): Promise<void> {
    if (routed.kind === "engine") {
      await this.cancelGeneration(
        routed.meta.session.sessionId,
        routed.meta.rid,
        "user cancelled",
      );
      return;
    }
    for (const sessionId of this.#sessions.keys()) {
      await this.cancelGeneration(sessionId, null, "all clients disconnected");
    }
    this.#deps.leases.clear();
  }

  async handleEngine(msg: ClientMessage, meta: RequestMeta): Promise<void> {
    if (msg.type === "cancel") {
      await this.cancelGeneration(meta.session.sessionId, meta.rid, "user cancelled");
      return;
    }
    if (msg.type !== "message" && msg.type !== "regen") return;

    const resolved = this.#deps.registry.resolveCharacter(meta.session.selectedCharacter);
    if ("error" in resolved) {
      await this.#deps.router.sendToSession(
        meta.session.sessionId,
        withRid(
          { type: "error", code: "invalid_request", message: resolved.error },
          meta.rid,
        ),
      );
      return;
    }

    const regen = msg.type === "regen";
    const body: EngineBody = regen
      ? {
          rid: msg.rid ?? null,
          text: "",
          stream: msg.stream,
          images: [],
          image_data: [],
          ...(msg.guidance === undefined || msg.guidance === null
            ? {}
            : { guidance: msg.guidance }),
        }
      : {
          rid: msg.rid ?? null,
          text: msg.text,
          stream: msg.stream,
          images: msg.images ?? [],
          image_data: msg.image_data ?? [],
          ...(msg.absence_seconds !== undefined
            ? { absence_seconds: msg.absence_seconds }
            : {}),
        };

    this.#deps.leases.observe(resolved.name, meta.session.sessionId, meta.kind);

    await this.launchGeneration(meta, body, regen, resolved.name);
  }

  async launchGeneration(
    meta: RequestMeta,
    body: EngineBody,
    regen: boolean,
    charName: string,
  ): Promise<void> {
    const issuerSend = this.#deps.router.senderFor(meta.session.sessionId);
    if (issuerSend === undefined) return;

    const rid = sanitiseRid(body.rid);
    const send = this.#deps.leases.fanout(
      charName,
      meta.session.sessionId,
      issuerSend,
      this.#deps.router,
    );

    const previousAbort = this.#sessions.get(meta.session.sessionId);
    if (previousAbort !== undefined) {
      this.#deps.log?.info?.("aborting previous generation (superseded by new request)");
      previousAbort();
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    this.#sessions.set(meta.session.sessionId, abort);

    const params: GenerationParams = {
      meta,
      body,
      regen,
      charName,
      rid,
      send,
      signal: controller.signal,
    };

    const running = this.#deps
      .runGeneration(params)
      .catch(async (error: unknown) => {
        if (controller.signal.aborted) return;
        const message = describeError(error);
        const retryAfterMs = retryAfterHint(error);
        this.#deps.log?.error?.("error processing engine message", { error: message });
        try {
          await send(withRid({
            type: "error",
            code: generationErrorCode(error),
            message,
            ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
          }, rid));
        } catch (sendError) {
          this.#deps.log?.error?.("failed to deliver generation error", {
            error: sendError instanceof Error ? sendError.message : String(sendError),
          });
        }
        this.#deps.notifier.notify("error", `Shore - ${charName}`, message);
      })
      .finally(() => {
        if (this.#sessions.get(meta.session.sessionId) === abort) {
          this.#sessions.delete(meta.session.sessionId);
        }
      });

    this.#inFlight.add(running);
    void running.finally(() => this.#inFlight.delete(running));
  }

  async cancelGeneration(
    sessionId: number,
    rid: string | null,
    reason: string,
  ): Promise<void> {
    const abort = this.#sessions.get(sessionId);
    if (abort === undefined) return;
    this.#deps.log?.info?.("cancelling active generation", { reason });
    abort();
    this.#sessions.delete(sessionId);
    await this.#deps.router.sendToSession(sessionId, cancelledStreamEnd(rid));
  }

  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled(this.#inFlight);
    }
  }

  readonly #inFlight = new Set<Promise<void>>();
}
