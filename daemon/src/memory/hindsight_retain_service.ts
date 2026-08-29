import { shoreLog } from "../log.ts";

import type { Message } from "../engine/types.ts";
import {
  HistoryStore,
  type MemoryRetainJob,
} from "../engine/history_store.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";

const RETAIN_TOOL = "retain";
const GET_OPERATION_TOOL = "get_operation";
const CANCEL_OPERATION_TOOL = "cancel_operation";
const DELETE_DOCUMENT_TOOL = "delete_document";
const MAX_RETRY_MS = 60_000;

const CONTEXT =
  "A private conversation between {user} and {character}, {pronoun} partner. " +
  "Constant teasing, insults, mock-outrage and running jokes are how they show " +
  "affection -- an insult is a joke, not a description, and a nickname is not a " +
  "fact about anyone. Record what each of them states about their own life, plans " +
  "and feelings, attributing it to whichever of them said it. Never convert banter, " +
  "hypotheticals, or things they imagine or roleplay into biography. " +
  "This session took place from {first} to {last}.";

export interface HindsightRetainRegistration {
  character: string;
  historyPath: string;
  server: string;
  userName: string;
  possessivePronoun: string;
  timeoutMs: number;
}

export interface HindsightRetainServiceOptions {
  now?: () => number;
  timerIntervalMs?: number;
  pollIntervalMs?: number;
}

export interface HindsightDocument {
  content: string;
  context: string;
  documentId: string;
}

export function hindsightDocument(
  character: string,
  segment: number,
  messages: readonly Message[],
  userName: string,
  possessivePronoun: string,
): HindsightDocument | undefined {
  const names: Record<Message["role"], string> = {
    user: userName,
    assistant: character,
    system: "system",
  };
  const lines: string[] = [];
  const stamps: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const text = message.content_blocks
      .map((block) => block.type === "text" ? block.text : "")
      .join(" ")
      .trim();
    if (text === "") continue;
    stamps.push(message.timestamp);
    lines.push(`${names[message.role]} (${message.timestamp}): ${text}`);
  }
  const first = stamps[0];
  const last = stamps.at(-1);
  if (lines.length === 0 || first === undefined || last === undefined) return undefined;
  return {
    content: lines.join("\n\n"),
    context: CONTEXT
      .replace("{user}", () => userName)
      .replace("{character}", () => character)
      .replace("{pronoun}", () => possessivePronoun)
      .replace("{first}", () => first.slice(0, 10))
      .replace("{last}", () => last.slice(0, 10)),
    documentId: `shore:${character}:seg${String(segment)}`,
  };
}

export class HindsightRetainService {
  readonly #registrations = new Map<string, HindsightRetainRegistration>();
  readonly #mcpRegistry: Pick<McpRegistry, "call">;
  readonly #now: () => number;
  readonly #timerIntervalMs: number;
  readonly #pollIntervalMs: number;
  readonly #stop = new AbortController();
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #lastPicked: string | undefined;
  #closed = false;

  constructor(
    mcpRegistry: Pick<McpRegistry, "call">,
    options: HindsightRetainServiceOptions = {},
  ) {
    this.#mcpRegistry = mcpRegistry;
    this.#now = options.now ?? Date.now;
    this.#timerIntervalMs = options.timerIntervalMs ?? 1_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 5_000;
  }

  register(registration: HindsightRetainRegistration): void {
    this.#registrations.set(registration.character, registration);
  }

  unregister(character: string): void {
    this.#registrations.delete(character);
  }

  registeredCharacters(): string[] {
    return [...this.#registrations.keys()];
  }

  start(): void {
    if (this.#closed || this.#timer !== undefined) return;
    void this.runOnce();
    this.#timer = setInterval(() => { void this.runOnce(); }, this.#timerIntervalMs);
    this.#timer.unref?.();
  }

  async runOnce(): Promise<void> {
    if (this.#closed || this.#running !== undefined) return await this.#running;
    const running = this.#runOnce();
    this.#running = running;
    try {
      await running;
    } finally {
      if (this.#running === running) this.#running = undefined;
    }
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    this.#stop.abort();
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  async #runOnce(): Promise<void> {
    const characters = [...this.#registrations.keys()];
    const after = this.#lastPicked === undefined ? -1 : characters.indexOf(this.#lastPicked);
    for (let step = 1; step <= characters.length; step += 1) {
      const character = characters[(after + step) % characters.length];
      if (character === undefined) continue;
      const registration = this.#registrations.get(character);
      if (registration === undefined) continue;
      const store = HistoryStore.open(registration.historyPath);
      try {
        const job = store.nextMemoryRetainJob(character, this.#now());
        if (job === undefined) continue;
        this.#lastPicked = character;
        await this.#process(store, registration, job);
      } finally {
        store.close();
      }
      break;
    }
  }

  async #process(
    store: HistoryStore,
    registration: HindsightRetainRegistration,
    job: MemoryRetainJob,
  ): Promise<void> {
    try {
      if (job.status === "delete_pending") {
        await this.#delete(registration, job);
        store.markMemoryDeleteComplete(job.character, job.segment);
        shoreLog.info(
          `shore: removed excluded archive document from hindsight for ${job.character} ` +
            `(segment=${String(job.segment)})`,
        );
        return;
      }
      if (job.status === "submitted") {
        await this.#poll(store, registration, job);
        return;
      }

      const document = hindsightDocument(
        job.character,
        job.segment,
        store.readSegment(job.character, job.segment),
        registration.userName,
        registration.possessivePronoun,
      );
      if (document === undefined) {
        store.markMemoryRetainSkipped(job.character, job.segment);
        shoreLog.debug(
          `shore: skipped empty hindsight archive document for ${job.character} ` +
            `(segment=${String(job.segment)})`,
        );
        return;
      }
      const response = await this.#call(registration, RETAIN_TOOL, {
        content: document.content,
        context: document.context,
        document_id: document.documentId,
      });
      const operationId = operationIdFrom(response);
      store.markMemoryRetainSubmitted(
        job.character,
        job.segment,
        operationId,
        this.#now() + this.#pollIntervalMs,
      );
      shoreLog.info(
        `shore: submitted archive to hindsight for ${job.character} ` +
          `(segment=${String(job.segment)}, document=${document.documentId})`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const retryAt = this.#now() + retryDelayMs(job.attempts);
      if (job.status === "delete_pending") {
        store.markMemoryDeleteFailure(job.character, job.segment, detail, retryAt);
      } else if (job.status === "submitted") {
        if (/\b(?:404|not found)\b/i.test(detail)) {
          store.markMemoryRetainComplete(job.character, job.segment);
        } else {
          store.markMemoryRetainPoll(job.character, job.segment, retryAt, detail);
        }
      } else {
        store.markMemoryRetainFailure(job.character, job.segment, detail, retryAt);
      }
      shoreLog.warn(
        `shore: hindsight archive ${job.status === "delete_pending" ? "delete" : "retain"} ` +
          `failed for ${job.character} segment ${String(job.segment)}; retrying later: ${detail}`,
      );
    }
  }

  async #poll(
    store: HistoryStore,
    registration: HindsightRetainRegistration,
    job: MemoryRetainJob,
  ): Promise<void> {
    const operationId = job.remote_operation_id;
    if (operationId === undefined) {
      store.markMemoryRetainComplete(job.character, job.segment);
      return;
    }
    const response = await this.#call(registration, GET_OPERATION_TOOL, {
      operation_id: operationId,
    });
    const status = operationStatusFrom(response);
    if (status === "completed") {
      store.markMemoryRetainComplete(job.character, job.segment);
      shoreLog.info(
        `shore: hindsight archive retain completed for ${job.character} ` +
          `(segment=${String(job.segment)}, operation=${operationId})`,
      );
      return;
    }
    if (status === "failed" || status === "cancelled") {
      const detail = operationErrorFrom(response) ?? `hindsight operation ${status}`;
      store.markMemoryRetainFailure(
        job.character,
        job.segment,
        detail,
        this.#now() + retryDelayMs(job.attempts),
      );
      shoreLog.warn(
        `shore: hindsight archive retain ${status} for ${job.character} ` +
          `(segment=${String(job.segment)}, operation=${operationId}): ${detail}`,
      );
      return;
    }
    store.markMemoryRetainPoll(
      job.character,
      job.segment,
      this.#now() + this.#pollIntervalMs,
    );
  }

  async #delete(
    registration: HindsightRetainRegistration,
    job: MemoryRetainJob,
  ): Promise<void> {
    if (job.remote_operation_id !== undefined) {
      try {
        await this.#call(registration, CANCEL_OPERATION_TOOL, {
          operation_id: job.remote_operation_id,
        });
      } catch {}
    }
    try {
      await this.#call(registration, DELETE_DOCUMENT_TOOL, {
        document_id: `shore:${job.character}:seg${String(job.segment)}`,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!/\b(?:404|not found)\b/i.test(detail)) throw error;
    }
  }

  async #call(
    registration: HindsightRetainRegistration,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const deadline = AbortSignal.timeout(registration.timeoutMs);
    const signal = AbortSignal.any([this.#stop.signal, deadline]);
    return await settleBeforeAbort(
      this.#mcpRegistry.call(`mcp__${registration.server}__${tool}`, args, signal),
      signal,
      `${tool} timed out after ${String(registration.timeoutMs)}ms`,
    );
  }
}

function retryDelayMs(attempts: number): number {
  return Math.min(1_000 * 2 ** Math.min(attempts, 20), MAX_RETRY_MS);
}

function operationIdFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      return operationIdFrom(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null) return undefined;
  const operationId = (value as Record<string, unknown>)["operation_id"];
  return typeof operationId === "string" && operationId !== "" ? operationId : undefined;
}

function operationStatusFrom(value: unknown): string | undefined {
  const parsed = parsedObject(value);
  const status = parsed?.["status"];
  return typeof status === "string" ? status.toLowerCase() : undefined;
}

function operationErrorFrom(value: unknown): string | undefined {
  const parsed = parsedObject(value);
  for (const key of ["error", "error_message", "message"]) {
    const detail = parsed?.[key];
    if (typeof detail === "string" && detail !== "") return detail;
  }
  return undefined;
}

function parsedObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return parsedObject(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function settleBeforeAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(timeoutMessage));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(timeoutMessage));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
