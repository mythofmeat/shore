import { shoreLog } from "../log.ts";

import type { Message } from "../engine/types.ts";
import {
  HistoryStore,
  type MemoryRetainJob,
} from "../engine/history_store.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";

const RETAIN_TOOL = "retain";
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
  readonly #stop = new AbortController();
  readonly #retry = new Map<string, { failures: number; notBefore: number }>();
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
  }

  register(registration: HindsightRetainRegistration): void {
    this.#registrations.set(registration.character, registration);
    this.#retry.delete(registration.character);
  }

  unregister(character: string): void {
    this.#registrations.delete(character);
    this.#retry.delete(character);
  }

  noteWork(character: string): void {
    this.#retry.delete(character);
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
      const now = this.#now();
      if ((this.#retry.get(character)?.notBefore ?? 0) > now) continue;
      const store = HistoryStore.open(registration.historyPath);
      try {
        const job = store.nextMemoryRetainJob(character);
        if (job === undefined) {
          this.#backOff(character, now);
          continue;
        }
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
    const documentId = `shore:${job.character}:seg${String(job.segment)}`;
    try {
      if (job.action === "delete") {
        await this.#delete(registration, documentId);
        store.markMemoryDocument(job.character, job.segment, null);
        this.#retry.delete(job.character);
        shoreLog.info(
          `shore: removed excluded archive document ${documentId} from hindsight`,
        );
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
        store.markMemoryDocument(job.character, job.segment, null);
        this.#retry.delete(job.character);
        shoreLog.debug(`shore: skipped empty hindsight archive document ${documentId}`);
        return;
      }
      await this.#call(registration, RETAIN_TOOL, {
        content: document.content,
        context: document.context,
        document_id: document.documentId,
      });
      store.markMemoryDocument(job.character, job.segment, "stored");
      this.#retry.delete(job.character);
      shoreLog.info(`shore: sent ${document.documentId} to hindsight for extraction`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failures = this.#backOff(job.character, this.#now());
      shoreLog.warn(
        `shore: hindsight archive ${job.action} failed for ${documentId} ` +
          `(attempt ${String(failures)}); retrying later: ${detail}`,
      );
    }
  }

  #backOff(character: string, now: number): number {
    const failures = (this.#retry.get(character)?.failures ?? 0) + 1;
    const grown = 1_000 * 2 ** Math.min(failures - 1, 20);
    this.#retry.set(character, {
      failures,
      notBefore: now + Math.min(grown, MAX_RETRY_MS),
    });
    return failures;
  }

  async #delete(
    registration: HindsightRetainRegistration,
    documentId: string,
  ): Promise<void> {
    try {
      await this.#call(registration, DELETE_DOCUMENT_TOOL, { document_id: documentId });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!/\b(?:404|not found)\b/i.test(detail)) throw error;
    }
  }

  async #call(
    registration: HindsightRetainRegistration,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const deadline = AbortSignal.timeout(registration.timeoutMs);
    const signal = AbortSignal.any([this.#stop.signal, deadline]);
    const raw = await settleBeforeAbort(
      this.#mcpRegistry.call(`mcp__${registration.server}__${tool}`, args, signal),
      signal,
      `${tool} timed out after ${String(registration.timeoutMs)}ms`,
    );
    const payload = parsedObject(raw);
    const failure = toolErrorFrom(payload);
    if (failure !== undefined) throw new HindsightToolError(`hindsight ${tool}: ${failure}`);
    return payload;
  }
}

export class HindsightToolError extends Error {}

function toolErrorFrom(payload: Record<string, unknown> | undefined): string | undefined {
  if (payload === undefined) return undefined;
  const status = payload["status"];
  if (status === "error") {
    const message = payload["message"];
    return typeof message === "string" && message !== "" ? message : "unspecified failure";
  }
  if (status !== undefined) return undefined;
  const error = payload["error"];
  return typeof error === "string" && error !== "" ? error : undefined;
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
