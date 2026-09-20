import { CharacterConfigError } from "../characters.ts";
import { isTimeoutError } from "../llm/abort.ts";
import { describeError, toLlmError } from "../llm/errors.ts";
import { retryAfterHint } from "../llm/fallback.ts";
import type { ClientMessage } from "../protocol/ClientMessage.ts";
import type { Command } from "../protocol/Command.ts";
import type { ErrorCode } from "../protocol/ErrorCode.ts";
import type { ServerMessage } from "../protocol/ServerMessage.ts";
import type { Error as ProtocolError } from "../protocol/Error.ts";
import type { RequestOutcome } from "../protocol/RequestOutcome.ts";
import { sanitiseRid } from "../swp/admission.ts";
import { ImagesUnsupportedError, NoModelError } from "./setup.ts";
import {
  isControlRoutedMessage,
  REQUEST_LIFECYCLE_CAPABILITY,
  type DirectSender,
  type ControlRoutedMessage,
  type RequestMeta,
  type RoutedMessage,
  type SessionRouter,
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
  "provider_warning",
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
  readonly dispatchCommand: (
    cmd: Command,
    meta: RequestMeta,
    signal: AbortSignal,
  ) => Promise<ServerMessage>;
  readonly runGeneration: RunGeneration;
  readonly log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void;
    error?: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export { sanitiseRid } from "../swp/admission.ts";

interface ActiveGeneration {
  readonly abort: () => void;
  readonly rid: string | null;
  outcome?: "cancelled" | "superseded";
}

export class MessageHandler {
  readonly #deps: MessageHandlerDeps;
  readonly #sessions = new Map<number, Map<string, ActiveGeneration>>();
  readonly #queues = new Map<number, Promise<void>>();
  readonly #commandAborts = new Map<number, Set<AbortController>>();

  constructor(deps: MessageHandlerDeps) {
    this.#deps = deps;
  }

  get sessionStateCount(): number {
    return this.#sessions.size;
  }

  get queuedSessionCount(): number {
    return this.#queues.size;
  }

  async run(routes: AsyncIterable<RoutedMessage>): Promise<void> {
    this.#deps.log?.info?.("message handler started");
    for await (const routed of routes) {
      this.enqueueRouted(routed);
    }
    await this.drain();
    this.#deps.log?.info?.("message handler shutting down (route stream closed)");
  }

  enqueueRouted(routed: RoutedMessage): void {
    if (isControlRoutedMessage(routed)) {
      this.#track(this.#guard(this.handleControl(routed)));
      return;
    }

    const sessionId = routed.meta.session.sessionId;
    const controller = routed.kind === "command" ? this.#commandController(sessionId) : undefined;
    const tail = this.#queues.get(sessionId) ?? Promise.resolve();
    const settled = this.#guard(
      tail.then(async () => {
        if (routed.kind === "command") { await this.#runCommand(routed.cmd, routed.meta, controller); return; }
        if (!this.#deps.router.has(sessionId)) return;
        await this.handleRouted(routed);
      }),
    );

    this.#queues.set(sessionId, settled);
    this.#track(settled);
    void settled.then(() => {
      if (this.#queues.get(sessionId) === settled) this.#queues.delete(sessionId);
    });
  }

  async handleRouted(routed: RoutedMessage): Promise<void> {
    switch (routed.kind) {
      case "command":
        await this.#runCommand(routed.cmd, routed.meta);
        return;
      case "engine":
        await this.handleEngine(routed.msg, routed.meta);
        return;
      case "session_disconnected":
      case "all_clients_disconnected": {
        await this.handleControl(routed);
      }
    }
  }

  #commandController(sessionId: number): AbortController {
    const controller = new AbortController();
    const registered = this.#commandAborts.get(sessionId) ?? new Set<AbortController>();
    registered.add(controller);
    this.#commandAborts.set(sessionId, registered);
    return controller;
  }

  async #runCommand(cmd: Command, meta: RequestMeta, controller = this.#commandController(meta.session.sessionId)): Promise<void> {
    const sessionId = meta.session.sessionId;
    let outcome: RequestOutcome = "completed";
    let failure: ProtocolError | undefined;

    try {
      if (!this.#deps.router.has(sessionId)) return;
      controller.signal.throwIfAborted();
      const result = await this.#deps.dispatchCommand(cmd, meta, controller.signal);
      if (!this.#deps.router.has(sessionId)) return;
      if (result.type === "error") { outcome = "failed"; failure = result; }
      await this.#deps.router.sendToSession(sessionId, result);
    } catch (error) {
      outcome = controller.signal.aborted ? "cancelled" : "failed";
      failure = { code: "internal_error", message: describeError(error) };
      if (!controller.signal.aborted) throw error;
    } finally {
      const live = this.#commandAborts.get(sessionId);
      if (live !== undefined) {
        live.delete(controller);
        if (live.size === 0) this.#commandAborts.delete(sessionId);
      }
      await this.#finishRequest(meta, meta.rid, outcome, failure);
    }
  }

  async #finishRequest(meta: RequestMeta, rid: string | null, outcome: RequestOutcome, error?: ProtocolError): Promise<void> {
    if (rid === null || !this.#deps.router.has(meta.session.sessionId) || !meta.session.capabilities.includes(REQUEST_LIFECYCLE_CAPABILITY)) return;
    await this.#deps.router.sendToSession(meta.session.sessionId, {
      type: "request_finished", rid, outcome, ...(error === undefined ? {} : { error }),
    });
  }

  async handleControl(routed: ControlRoutedMessage): Promise<void> {
    if (routed.kind === "engine") {
      this.#abortSessionCommands(routed.meta.session.sessionId, "User requested cancellation");
      await this.cancelGeneration(
        routed.meta.session.sessionId,
        routed.meta.rid,
        "user cancelled",
      );
      return;
    }
    if (routed.kind === "session_disconnected") {
      this.#abortSessionCommands(routed.sessionId, "Client disconnected");
      this.#queues.delete(routed.sessionId);
      return;
    }
    for (const sessionId of this.#sessions.keys()) {
      await this.cancelGeneration(sessionId, null, "all clients disconnected");
    }
    this.#deps.leases.clear();
  }

  #abortSessionCommands(sessionId: number, reason: string): void {
    const registered = this.#commandAborts.get(sessionId);
    if (registered === undefined) return;
    this.#deps.log?.info?.("cancelling session commands", {
      session_id: sessionId,
      commands: registered.size,
      reason,
    });
    for (const controller of registered) controller.abort(new DOMException(reason, "AbortError"));
    this.#commandAborts.delete(sessionId);
  }

  #guard(work: Promise<void>): Promise<void> {
    return work.catch((error: unknown) => {
      this.#deps.log?.error?.("error handling routed message", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  #track(work: Promise<void>): void {
    this.#inFlight.add(work);
    void work.then(() => this.#inFlight.delete(work));
  }

  async handleEngine(msg: ClientMessage, meta: RequestMeta): Promise<void> {
    if (msg.type === "cancel") {
      this.#abortSessionCommands(meta.session.sessionId, "User requested cancellation");
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
      await this.#finishRequest(meta, meta.rid, "failed", { code: "invalid_request", message: resolved.error });
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

    this.#deps.leases.observe(resolved.name, meta.session.sessionId, meta.kind, undefined, meta.session.selectedThread);

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
    const thread = meta.session.selectedThread;
    const scope = JSON.stringify([charName, thread]);
    const selectedCharacter = this.#deps.router.characterFor(meta.session.sessionId);
    const inSelectedThread = () =>
      this.#deps.router.characterFor(meta.session.sessionId) === selectedCharacter &&
      this.#deps.router.threadFor(meta.session.sessionId) === thread;
    const send = this.#deps.leases.fanout(
      charName,
      meta.session.sessionId,
      async (msg) => { if (inSelectedThread()) await issuerSend(msg); },
      this.#deps.router,
      undefined,
      thread,
    );

    const generations = this.#sessions.get(meta.session.sessionId) ?? new Map<string, ActiveGeneration>();
    const previous = generations.get(scope);
    if (previous !== undefined) {
      this.#deps.log?.info?.("aborting previous generation (superseded by new request)");
      previous.outcome = "superseded";
      previous.abort();
      if (previous.rid !== null) await issuerSend(cancelledStreamEnd(previous.rid));
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    const generation: ActiveGeneration = { abort, rid };
    generations.set(scope, generation);
    this.#sessions.set(meta.session.sessionId, generations);

    const params: GenerationParams = {
      meta,
      body,
      regen,
      charName,
      rid,
      send,
      signal: controller.signal,
    };

    let failure: ProtocolError | undefined;
    const running = (async () => {
      try {
        await this.#deps.runGeneration(params);
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = describeError(error);
        const retryAfterMs = retryAfterHint(error);
        failure = {
          code: generationErrorCode(error), message,
          ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
        };
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
      } finally {
        if (generations.get(scope) === generation) {
          generations.delete(scope);
          if (generations.size === 0) this.#sessions.delete(meta.session.sessionId);
        }
        await this.#finishRequest(meta, rid, generation.outcome ?? (failure === undefined ? "completed" : "failed"), failure);
      }
    })();

    this.#track(this.#guard(running));
  }

  async cancelGeneration(
    sessionId: number,
    rid: string | null,
    reason: string,
  ): Promise<void> {
    const generations = this.#sessions.get(sessionId);
    if (generations === undefined) return;
    const resolved = this.#deps.registry.resolveCharacter(this.#deps.router.characterFor(sessionId));
    const scope = JSON.stringify([
      "name" in resolved ? resolved.name : null, this.#deps.router.threadFor(sessionId),
    ]);
    const selected = reason === "all clients disconnected"
      ? [...generations.entries()]
      : [...generations.entries()].filter(([key]) => key === scope);
    if (selected.length === 0) return;
    this.#deps.log?.info?.("cancelling active generation", { reason });
    for (const [key, generation] of selected) {
      generation.outcome = "cancelled";
      generation.abort();
      generations.delete(key);
    }
    if (generations.size === 0) this.#sessions.delete(sessionId);
    const correlations = new Set(selected.map(([, generation]) => generation.rid));
    if (rid !== null) correlations.add(rid);
    if (correlations.size > 1) correlations.delete(null);
    for (const correlation of correlations) {
      await this.#deps.router.sendToSession(sessionId, cancelledStreamEnd(correlation));
    }
  }

  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled(this.#inFlight);
    }
  }

  readonly #inFlight = new Set<Promise<void>>();
}
