import { coreRequests } from "../operations/requests.ts";
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
  resolveThread?(character: string, selected: string | null): string | null;
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
  readonly accepted?: () => Promise<void>;
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
  readonly router: SessionRouter;
  readonly registry: HandlerRegistry;
  readonly notifier: HandlerNotifier;
  readonly dispatchCommand: (
    cmd: Command,
    meta: RequestMeta,
    signal: AbortSignal,
  ) => Promise<ServerMessage>;
  readonly runGeneration: RunGeneration;
  readonly commandChangesState?: (cmd: Command) => boolean;
  readonly log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void;
    error?: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

export { sanitiseRid } from "../swp/admission.ts";

const REPLAYED: ReadonlySet<string> = new Set([
  "stream_start",
  "stream_chunk",
  "stream_end",
  "tool_call",
  "tool_result",
]);

interface Viewer {
  readonly character: string | null;
  readonly thread: string | null;
}

interface ActiveGeneration {
  readonly scope: string;
  readonly abort: () => void;
  readonly rid: string | null;
  readonly viewers: Map<number, Viewer>;
  readonly replay: ServerMessage[];
  readonly send: DirectSender;
  finished: boolean;
  outcome?: "cancelled" | "superseded";
}

interface ActiveCommand {
  readonly controller: AbortController;
  readonly sessionId: number;
  readonly scope: string;
  readonly changesState: boolean;
}

function recordReplay(generation: ActiveGeneration, msg: ServerMessage): void {
  if (generation.finished || !REPLAYED.has(msg.type)) return;
  if ("subagent" in msg && msg.subagent !== undefined && msg.subagent !== null) return;
  if ("task_id" in msg && msg.task_id !== undefined && msg.task_id !== null) return;
  if (msg.type === "stream_end" && msg.is_final) {
    generation.finished = true;
    generation.replay.length = 0;
    return;
  }
  const last = generation.replay.at(-1);
  if (msg.type === "stream_chunk" && last?.type === "stream_chunk" && last.content_type === msg.content_type) {
    generation.replay[generation.replay.length - 1] = { ...last, text: last.text + msg.text };
    return;
  }
  generation.replay.push(msg);
}

export class MessageHandler {
  readonly #deps: MessageHandlerDeps;
  readonly #generations = new Map<string, ActiveGeneration>();
  readonly #queues = new Map<number, Promise<void>>();
  readonly #commands = new Set<ActiveCommand>();

  constructor(deps: MessageHandlerDeps) {
    this.#deps = deps;
  }

  get generationCount(): number {
    return this.#generations.size;
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
    const command = routed.kind === "command" ? this.#registerCommand(routed.cmd, routed.meta) : undefined;
    const tail = this.#queues.get(sessionId) ?? Promise.resolve();
    const settled = this.#guard(
      tail.then(async () => {
        if (routed.kind === "command") { await this.#runCommand(routed.cmd, routed.meta, command); return; }
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
      case "session_connected":
      case "session_disconnected": {
        await this.handleControl(routed);
      }
    }
  }

  #scope(character: string | null, thread: string | null): string {
    const resolved = this.#deps.registry.resolveCharacter(character);
    if (!("name" in resolved)) return JSON.stringify([null, thread]);
    return JSON.stringify([resolved.name, this.#deps.registry.resolveThread?.(resolved.name, thread) ?? thread]);
  }

  #sessionScope(sessionId: number): string {
    return this.#scope(this.#deps.router.characterFor(sessionId), this.#deps.router.threadFor(sessionId));
  }

  #viewer(sessionId: number): Viewer {
    return { character: this.#deps.router.characterFor(sessionId), thread: this.#deps.router.threadFor(sessionId) };
  }

  #join(sessionId: number): void {
    for (const generation of this.#generations.values()) generation.viewers.delete(sessionId);
    const send = this.#deps.router.senderFor(sessionId);
    if (send === undefined) return;
    const generation = this.#generations.get(this.#sessionScope(sessionId));
    if (generation === undefined || generation.finished) return;
    generation.viewers.set(sessionId, this.#viewer(sessionId));
    for (const frame of generation.replay) void this.#deliver(send, frame, sessionId);
  }

  async #deliver(send: DirectSender, msg: ServerMessage, sessionId: number): Promise<void> {
    try {
      await send(msg);
    } catch (error) {
      this.#deps.log?.error?.("failed to deliver stream frame", {
        session_id: sessionId,
        frame_type: msg.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #registerCommand(cmd: Command, meta: RequestMeta): ActiveCommand {
    const command: ActiveCommand = {
      controller: new AbortController(),
      sessionId: meta.session.sessionId,
      scope: this.#scope(meta.session.selectedCharacter, meta.session.selectedThread),
      changesState: this.#deps.commandChangesState?.(cmd) ?? true,
    };
    this.#commands.add(command);
    return command;
  }

  async #runCommand(cmd: Command, meta: RequestMeta, command = this.#registerCommand(cmd, meta)): Promise<void> {
    const sessionId = meta.session.sessionId;
    const controller = command.controller;
    const before = this.#sessionScope(sessionId);
    let outcome: RequestOutcome = "completed";
    let failure: ProtocolError | undefined;

    try {
      controller.signal.throwIfAborted();
      const result = await this.#deps.dispatchCommand(cmd, meta, controller.signal);
      if (result.type === "error") { outcome = "failed"; failure = result; }
      this.#deps.router.reportRequest(sessionId, result);
      await this.#deps.router.sendToSession(sessionId, result);
      if (this.#deps.router.has(sessionId) && this.#sessionScope(sessionId) !== before) this.#join(sessionId);
    } catch (error) {
      outcome = controller.signal.aborted ? "cancelled" : "failed";
      failure = { code: "internal_error", message: describeError(error) };
      if (!controller.signal.aborted) throw error;
      if (!meta.session.capabilities.includes(REQUEST_LIFECYCLE_CAPABILITY)) {
        await this.#deps.router.sendToSession(sessionId, withRid({ type: "error", code: "invalid_request", message: "Command cancelled before completion" }, meta.rid));
      }
    } finally {
      this.#commands.delete(command);
      await this.#finishRequest(meta, meta.rid, outcome, failure);
    }
  }

  async #finishRequest(meta: RequestMeta, rid: string | null, outcome: RequestOutcome, error?: ProtocolError): Promise<void> {
    if (rid === null) return;
    const finished: ServerMessage = { type: "request_finished", rid, outcome, ...(error === undefined ? {} : { error }) };
    this.#deps.router.reportRequest(meta.session.sessionId, finished);
    if (!this.#lifecycle(meta)) return;
    await this.#deps.router.sendToSession(meta.session.sessionId, finished);
  }

  async #acceptRequest(meta: RequestMeta, rid: string | null): Promise<void> {
    if (rid === null) return;
    const accepted: ServerMessage = { type: "request_accepted", rid };
    this.#deps.router.reportRequest(meta.session.sessionId, accepted);
    const send = this.#lifecycle(meta) ? this.#deps.router.senderFor(meta.session.sessionId) : undefined;
    if (send !== undefined) await this.#deliver(send, accepted, meta.session.sessionId);
  }

  #lifecycle(meta: RequestMeta): boolean {
    return this.#deps.router.has(meta.session.sessionId) && meta.session.capabilities.includes(REQUEST_LIFECYCLE_CAPABILITY);
  }

  async handleControl(routed: ControlRoutedMessage): Promise<void> {
    if (routed.kind === "engine") {
      await this.#cancel(routed.meta.session.sessionId, routed.meta.rid);
      return;
    }
    if (routed.kind === "session_connected") {
      this.#join(routed.sessionId);
      return;
    }
    this.#abortCommands(
      (command) => command.sessionId === routed.sessionId && !command.changesState,
      "Client disconnected",
    );
    for (const generation of this.#generations.values()) generation.viewers.delete(routed.sessionId);
    this.#queues.delete(routed.sessionId);
  }

  async #cancel(sessionId: number, rid: string | null): Promise<void> {
    const scope = this.#sessionScope(sessionId);
    this.#abortCommands(
      (command) => command.sessionId === sessionId ||
        (command.changesState && command.scope === scope && !this.#deps.router.has(command.sessionId)),
      "User requested cancellation",
    );
    await this.cancelGeneration(sessionId, rid, "user cancelled");
  }

  #abortCommands(selected: (command: ActiveCommand) => boolean, reason: string): void {
    const aborted = [...this.#commands].filter(selected);
    if (aborted.length === 0) return;
    this.#deps.log?.info?.("cancelling commands", { commands: aborted.length, reason });
    for (const command of aborted) {
      command.controller.abort(new DOMException(reason, "AbortError"));
      this.#commands.delete(command);
    }
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
    if (msg.type === "hello" || msg.type === "command") return;
    const plan = coreRequests[msg.type].invoke(msg);
    if (plan.kind === "cancel") {
      await this.#cancel(meta.session.sessionId, meta.rid);
      return;
    }

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

    await this.launchGeneration(meta, plan.body, plan.regen, resolved.name);
  }

  async launchGeneration(
    meta: RequestMeta,
    body: EngineBody,
    regen: boolean,
    charName: string,
  ): Promise<void> {
    const issuer = meta.session.sessionId;
    const rid = sanitiseRid(body.rid);
    const scope = this.#scope(charName, meta.session.selectedThread);

    const previous = this.#generations.get(scope);
    if (previous !== undefined) {
      this.#deps.log?.info?.("aborting previous generation (superseded by new request)");
      this.#generations.delete(scope);
      previous.outcome = "superseded";
      previous.abort();
      if (previous.rid !== null) await previous.send(cancelledStreamEnd(previous.rid));
    }

    const viewers = new Map<number, Viewer>();
    for (const [sessionId] of this.#deps.router.sessions()) {
      if (this.#sessionScope(sessionId) === scope) viewers.set(sessionId, this.#viewer(sessionId));
    }

    const controller = new AbortController();
    const generation: ActiveGeneration = {
      scope,
      abort: () => controller.abort(),
      rid,
      viewers,
      replay: [],
      finished: false,
      send: async (msg) => {
        recordReplay(generation, msg);
        let issuerDelivery: Promise<void> | undefined;
        for (const [sessionId, viewer] of generation.viewers) {
          const target = this.#deps.router.senderFor(sessionId);
          const current = this.#viewer(sessionId);
          if (target === undefined || current.character !== viewer.character || current.thread !== viewer.thread) {
            generation.viewers.delete(sessionId);
            continue;
          }
          if (sessionId !== issuer) {
            void this.#deliver(target, msg, sessionId);
            continue;
          }
          if (!body.stream && (msg.type === "stream_chunk" || (msg.type === "stream_start" && !msg.regen))) continue;
          issuerDelivery = target(msg);
        }
        await issuerDelivery;
      },
    };
    this.#generations.set(scope, generation);
    const send = generation.send;

    const params: GenerationParams = {
      meta,
      body,
      regen,
      charName,
      rid,
      send,
      signal: controller.signal,
      accepted: () => this.#acceptRequest(meta, rid),
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
        if (this.#generations.get(scope) === generation) this.#generations.delete(scope);
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
    const scope = this.#sessionScope(sessionId);
    const generation = this.#generations.get(scope);
    if (generation === undefined) return;
    this.#deps.log?.info?.("cancelling active generation", { reason });
    this.#generations.delete(scope);
    generation.outcome = "cancelled";
    generation.abort();
    const correlations = new Set([generation.rid]);
    if (rid !== null) correlations.add(rid);
    if (correlations.size > 1) correlations.delete(null);
    for (const correlation of correlations) {
      const frame = cancelledStreamEnd(correlation);
      await generation.send(frame);
      if (!generation.viewers.has(sessionId)) await this.#deps.router.sendToSession(sessionId, frame);
    }
  }

  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled(this.#inFlight);
    }
  }

  readonly #inFlight = new Set<Promise<void>>();
}
