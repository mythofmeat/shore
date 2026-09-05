import { shoreLog } from "../log.ts";

import type { Message } from "../engine/types.ts";
import {
  HistoryStore,
  characterOfArchiveKey,
  type MemoryRetainJob,
} from "../engine/history_store.ts";
import { processingUnitId, versionOf } from "../engine/versions.ts";
import { claimUncovered, versionsIn } from "./coverage.ts";
import type { MemoryBackend } from "./backend.ts";

const RETAIN_TOOL = "retain";
const DELETE_DOCUMENT_TOOL = "delete_document";
const GET_DOCUMENT_TOOL = "get_document";
const GET_OPERATION_TOOL = "get_operation";
const LIST_OPERATIONS_TOOL = "list_operations";

const MAX_RETRY_MS = 60_000;
const MAX_ATTEMPTS = 10;
const CONFIRM_INTERVAL_MS = 60_000;
const CONFIRM_WINDOW_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 60 * 60_000;
const OPERATION_PAGE = 100;

const IN_FLIGHT = new Set(["pending", "processing", "running", "queued"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "not_found"]);

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
  userName: string;
  possessivePronoun: string;
  timeoutMs: number;
}

export interface HindsightRetainServiceOptions {
  now?: () => number;
  maxAttempts?: number;
  confirmIntervalMs?: number;
  confirmWindowMs?: number;
  sweepIntervalMs?: number;
  openStore?: (path: string) => HistoryStore;
  runActivity?: <T>(run: () => Promise<T>) => Promise<T>;
}

export interface HindsightDocument {
  content: string;
  context: string;
  documentId: string;
}

export function hindsightDocumentId(archiveKey: string, segment: number): string {
  return `shore:${archiveKey}:seg${String(segment)}`;
}

export function hindsightUnitDocumentId(character: string, versions: readonly string[]): string {
  return `shore:${character}:${processingUnitId(versions)}`;
}

function unitOf(character: string, documentId: string): string | undefined {
  const prefix = `shore:${character}:`;
  return documentId.startsWith(prefix) ? documentId.slice(prefix.length) : undefined;
}

export interface HindsightUnit {
  kind: "unit";
  documentId: string;
  claim: string;
  messages: Message[];
  background: number;
}

export type HindsightUnitPlan =
  | HindsightUnit
  | { kind: "covered" }
  | { kind: "claimed_elsewhere" };

export function hindsightUnitFor(
  store: HistoryStore,
  archiveKey: string,
  segment: number,
  nowMs: number,
): HindsightUnitPlan {
  const character = characterOfArchiveKey(archiveKey);
  const messages = store.readSegment(archiveKey, segment);
  if (messages.length === 0) return { kind: "covered" };

  const present = versionsIn(messages);
  const covered = store.coveredMemoryVersions(character, "hindsight", present);
  const unversioned = messages.some((message) => versionOf(message) === undefined);
  if (!unversioned && covered.size === present.length) return { kind: "covered" };

  const planned = claimUncovered(store, character, "hindsight", messages, { nowMs });
  const claimable = new Set(planned.claimed);
  const fresh = messages.filter((message) => {
    const version = versionOf(message);
    return version === undefined || claimable.has(version);
  });
  if (fresh.length === 0) return { kind: "claimed_elsewhere" };
  const versions = versionsIn(fresh);
  return {
    kind: "unit",
    documentId:
      versions.length === 0
        ? hindsightDocumentId(archiveKey, segment)
        : hindsightUnitDocumentId(character, versions),
    claim: planned.claim,
    messages: fresh,
    background: messages.length - fresh.length,
  };
}

export function hindsightDocument(
  character: string,
  segment: number,
  messages: readonly Message[],
  userName: string,
  possessivePronoun: string,
  archiveKey = character,
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
    documentId: hindsightDocumentId(archiveKey, segment),
  };
}

interface InFlightRetain {
  documentId: string;
  claim: string | undefined;
}

export class HindsightRetainService {
  readonly #registrations = new Map<string, HindsightRetainRegistration>();
  readonly #backend: (character: string) => MemoryBackend | undefined;
  readonly #now: () => number;
  readonly #maxAttempts: number;
  readonly #confirmIntervalMs: number;
  readonly #confirmWindowMs: number;
  readonly #sweepIntervalMs: number;
  readonly #openStore: (path: string) => HistoryStore;
  readonly #runActivity: <T>(run: () => Promise<T>) => Promise<T>;
  readonly #stop = new AbortController();
  readonly #deadlines = new Map<string, number | undefined>();
  #nextSweep = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #started = false;
  #lastPicked: string | undefined;
  #closed = false;

  constructor(
    backend: (character: string) => MemoryBackend | undefined,
    options: HindsightRetainServiceOptions = {},
  ) {
    this.#backend = backend;
    this.#now = options.now ?? Date.now;
    this.#maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.#confirmIntervalMs = options.confirmIntervalMs ?? CONFIRM_INTERVAL_MS;
    this.#confirmWindowMs = options.confirmWindowMs ?? CONFIRM_WINDOW_MS;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.#openStore = options.openStore ?? ((path) => HistoryStore.open(path));
    this.#runActivity = options.runActivity ?? (async (run) => await run());
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1) {
      throw new RangeError("maxAttempts must be a positive integer");
    }
  }

  register(registration: HindsightRetainRegistration): void {
    const previous = this.#registrations.get(registration.character);
    this.#registrations.set(registration.character, registration);
    if (previous !== undefined && sameRegistration(previous, registration)) return;
    this.#deadlines.set(registration.character, 0);
    this.#schedule();
  }

  unregister(character: string): void {
    this.#registrations.delete(character);
    this.#deadlines.delete(character);
    this.#schedule();
  }

  noteWork(character: string): void {
    if (!this.#registrations.has(character)) return;
    this.#deadlines.set(character, 0);
    this.#schedule();
  }

  registeredCharacters(): string[] {
    return [...this.#registrations.keys()];
  }

  start(): void {
    if (this.#closed || this.#started) return;
    this.#started = true;
    void this.runOnce();
  }

  async runOnce(): Promise<void> {
    if (this.#closed || this.#running !== undefined) return await this.#running;
    const running = this.#runActivity(async () => await this.#runOnce());
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
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  async #runOnce(): Promise<void> {
    const now = this.#now();
    if (now >= this.#nextSweep) {
      this.#nextSweep = now + this.#sweepIntervalMs;
      for (const character of this.#registrations.keys()) this.#deadlines.set(character, 0);
    }
    const characters = [...this.#registrations.keys()];
    const after = this.#lastPicked === undefined ? -1 : characters.indexOf(this.#lastPicked);
    for (let step = 1; step <= characters.length; step += 1) {
      const character = characters[(after + step) % characters.length];
      if (character === undefined) continue;
      const registration = this.#registrations.get(character);
      if (registration === undefined) continue;
      const due = this.#deadlines.get(character);
      if (due === undefined || due > now) continue;
      const store = this.#openStore(registration.historyPath);
      let job: MemoryRetainJob | undefined;
      try {
        store.backfillThreadArchiveRetention(character);
        job = store.nextCharacterMemoryRetainJob(character, now);
        if (job !== undefined) {
          this.#lastPicked = character;
          await this.#process(store, registration, job);
        }
        this.#deadlines.set(character, store.nextCharacterMemoryRetainDeadline(character));
      } finally {
        store.close();
      }
      if (job !== undefined) break;
    }
    this.#schedule();
  }

  #schedule(): void {
    if (!this.#started || this.#closed) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    let target = this.#nextSweep;
    for (const due of this.#deadlines.values()) {
      if (due !== undefined && due < target) target = due;
    }
    const delay = Math.max(0, target - this.#now());
    this.#timer = setTimeout(() => { void this.runOnce(); }, delay);
    this.#timer.unref?.();
  }

  async #process(
    store: HistoryStore,
    registration: HindsightRetainRegistration,
    job: MemoryRetainJob,
  ): Promise<void> {
    const documentId = job.documentId ?? hindsightDocumentId(job.archiveKey, job.segment);
    const inFlight: InFlightRetain = { documentId, claim: job.claim };
    let attempts = job.attempts;
    try {
      if (job.action === "delete") {
        attempts += 1;
        await this.#processDelete(store, registration, job, documentId);
        return;
      }
      if (job.action === "confirm") {
        await this.#processConfirm(store, registration, job, documentId);
        return;
      }
      attempts += 1;
      await this.#processRetain(store, registration, job, documentId, inFlight);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#recordFailure(store, job, inFlight, detail, attempts);
    }
  }

  async #processRetain(
    store: HistoryStore,
    registration: HindsightRetainRegistration,
    job: MemoryRetainJob,
    fallbackDocumentId: string,
    inFlight: InFlightRetain,
  ): Promise<void> {
    const now = this.#now();
    const plan = hindsightUnitFor(store, job.archiveKey, job.segment, now);
    if (plan.kind === "covered") {
      this.#adoptCoveredUnit(store, registration.character, job, fallbackDocumentId);
      return;
    }
    if (plan.kind === "claimed_elsewhere") {
      store.deferMemoryDocument(
        job.archiveKey,
        job.segment,
        now + this.#confirmIntervalMs,
        "another branch is retaining this material; waiting for it to finish",
      );
      return;
    }
    const unit = plan;
    const documentId = unit.documentId;
    inFlight.documentId = documentId;
    inFlight.claim = unit.claim;
    store.setMemoryDocumentIdentity(job.archiveKey, job.segment, documentId, unit.claim);
    store.beginMemorySubmission(
      job.archiveKey,
      job.segment,
      now + this.#confirmIntervalMs,
      now + this.#confirmWindowMs,
    );
    if (job.attempts > 0 && await this.#adopt(store, registration, { ...job, claim: unit.claim }, documentId)) {
      return;
    }
    const document = hindsightDocument(
      registration.character,
      job.segment,
      unit.messages,
      registration.userName,
      registration.possessivePronoun,
      job.archiveKey,
    );
    if (document === undefined) {
      store.releaseMemoryCoverage(registration.character, "hindsight", unit.claim);
      store.markMemoryDocument(job.archiveKey, job.segment, null);
      shoreLog.debug(`shore: skipped empty hindsight archive document ${documentId}`);
      return;
    }
    const payload = await this.#call(registration, RETAIN_TOOL, {
      content: document.content,
      context: document.context,
      document_id: documentId,
    });
    const operation = acceptedOperation(payload);
    if (operation === undefined) {
      throw new HindsightToolError(
        `hindsight ${RETAIN_TOOL} did not accept the document: ${describe(payload)}`,
      );
    }
    store.recordMemoryOperation(
      job.archiveKey,
      job.segment,
      operation,
      this.#now() + this.#confirmIntervalMs,
    );
    shoreLog.info(
      `shore: submitted ${documentId} to hindsight as operation ${operation}`,
    );
  }

  async #processConfirm(
    store: HistoryStore,
    registration: HindsightRetainRegistration,
    job: MemoryRetainJob,
    documentId: string,
  ): Promise<void> {
    if (job.operation === undefined) {
      if (!await this.#adopt(store, registration, job, documentId)) {
        this.#requeue(
          store,
          registration.character,
          job,
          `hindsight has no record of ${documentId}; resubmitting`,
          job.attempts >= this.#maxAttempts,
        );
      }
      return;
    }
    const status = await this.#operationStatus(registration, job.operation);
    if (status.status === "completed" || status.status === "not_found") {
      if (await this.#documentExists(registration, documentId)) {
        this.#confirmStored(store, registration.character, job, documentId);
        shoreLog.info(`shore: hindsight stored ${documentId}`);
        return;
      }
      this.#requeue(
        store,
        registration.character,
        job,
        status.status === "completed"
          ? `hindsight finished operation ${job.operation} without storing ${documentId}`
          : `hindsight lost operation ${job.operation} and has no ${documentId}`,
        job.attempts >= this.#maxAttempts,
      );
      return;
    }
    if (status.status === "failed" || status.status === "cancelled") {
      this.#requeue(
        store,
        registration.character,
        job,
        `hindsight retain operation ${status.status}${
          status.error === undefined ? "" : `: ${status.error}`
        }`,
        job.attempts >= this.#maxAttempts,
      );
      return;
    }
    const now = this.#now();
    if (now >= job.expires) {
      this.#requeue(
        store,
        registration.character,
        job,
        `hindsight operation ${job.operation} was still ${status.status} at the end of the ` +
          "confirmation window; resubmitting",
        job.attempts >= this.#maxAttempts,
      );
      return;
    }
    store.deferMemoryDocument(job.archiveKey, job.segment, now + this.#confirmIntervalMs);
  }

  async #processDelete(
    store: HistoryStore,
    registration: HindsightRetainRegistration,
    job: MemoryRetainJob,
    documentId: string,
  ): Promise<void> {
    const now = this.#now();
    if (job.status === "submitted" && now < job.expires) {
      if (job.operation === undefined) {
        const found = await this.#findOperation(registration, documentId);
        if (found !== undefined) {
          store.recordMemoryOperation(
            job.archiveKey,
            job.segment,
            found,
            now + this.#confirmIntervalMs,
          );
          return;
        }
      } else if (!TERMINAL.has((await this.#operationStatus(registration, job.operation)).status)) {
        store.deferMemoryDocument(job.archiveKey, job.segment, now + this.#confirmIntervalMs);
        return;
      }
    }
    const supporting = store.eligibleDocumentOccurrences(
      registration.character,
      "hindsight",
      documentId,
    );
    if (supporting.length > 0) {
      store.markMemoryDocument(job.archiveKey, job.segment, null);
      store.setMemoryDocumentIdentity(job.archiveKey, job.segment, null, null);
      shoreLog.info(
        `shore: kept hindsight document ${documentId}; ` +
          `${String(supporting.length)} other included occurrence(s) still support it`,
      );
      return;
    }
    await this.#delete(registration, documentId);
    store.markMemoryDocument(job.archiveKey, job.segment, null);
    store.setMemoryDocumentIdentity(job.archiveKey, job.segment, null, null);
    store.releaseHindsightUnitCoverage(registration.character, documentId);
    shoreLog.info(`shore: removed excluded archive document ${documentId} from hindsight`);
  }

  #requeue(
    store: HistoryStore,
    character: string,
    job: MemoryRetainJob,
    error: string,
    exhausted: boolean,
    due = 0,
  ): void {
    if (job.claim !== undefined) {
      store.releaseMemoryCoverage(character, "hindsight", job.claim);
    }
    store.setMemoryDocumentIdentity(job.archiveKey, job.segment, null, null);
    store.requeueMemoryDocument(job.archiveKey, job.segment, error, exhausted, due);
  }

  #confirmStored(
    store: HistoryStore,
    character: string,
    job: MemoryRetainJob,
    documentId: string,
  ): void {
    const claim = job.claim;
    if (claim !== undefined) {
      store.commitMemoryCoverage(character, "hindsight", claim, unitOf(character, documentId));
    }
    store.markMemoryDocumentOccurrence(
      character,
      "hindsight",
      documentId,
      job.archiveKey,
      job.segment,
    );
    store.markMemoryDocument(job.archiveKey, job.segment, "stored");
    store.setMemoryDocumentIdentity(job.archiveKey, job.segment, documentId, null);
  }

  #adoptCoveredUnit(
    store: HistoryStore,
    character: string,
    job: MemoryRetainJob,
    fallbackDocumentId: string,
  ): void {
    const versions = versionsIn(store.readSegment(job.archiveKey, job.segment));
    const units = store.memoryUnitsFor(character, "hindsight", versions);
    for (const unit of units) {
      store.markMemoryDocumentOccurrence(
        character,
        "hindsight",
        `shore:${character}:${unit}`,
        job.archiveKey,
        job.segment,
      );
    }
    const documentId = units.length === 1 ? `shore:${character}:${units[0] ?? ""}` : null;
    store.setMemoryDocumentIdentity(job.archiveKey, job.segment, documentId, null);
    store.markMemoryDocument(job.archiveKey, job.segment, versions.length === 0 ? null : "stored");
    shoreLog.info(
      versions.length === 0
        ? `shore: nothing to retain for ${fallbackDocumentId}`
        : `shore: ${fallbackDocumentId} was already retained from another branch; ` +
          `recorded it as an occurrence of ${String(units.length)} shared document(s)`,
    );
  }

  async #adopt(
    store: HistoryStore,
    registration: HindsightRetainRegistration,
    job: MemoryRetainJob,
    documentId: string,
  ): Promise<boolean> {
    if (await this.#documentExists(registration, documentId)) {
      this.#confirmStored(store, registration.character, job, documentId);
      shoreLog.info(`shore: adopted the hindsight document already stored for ${documentId}`);
      return true;
    }
    const operation = await this.#findOperation(registration, documentId);
    if (operation === undefined) return false;
    store.recordMemoryOperation(
      job.archiveKey,
      job.segment,
      operation,
      this.#now() + this.#confirmIntervalMs,
    );
    shoreLog.info(
      `shore: adopted in-flight hindsight operation ${operation} for ${documentId}`,
    );
    return true;
  }

  #recordFailure(
    store: HistoryStore,
    job: MemoryRetainJob,
    inFlight: InFlightRetain,
    detail: string,
    attempts: number,
  ): void {
    const documentId = inFlight.documentId;
    if (job.action === "confirm") {
      store.deferMemoryDocument(
        job.archiveKey,
        job.segment,
        this.#now() + this.#confirmIntervalMs,
        detail,
      );
      shoreLog.warn(
        `shore: could not confirm hindsight document ${documentId}; retrying later: ${detail}`,
      );
      return;
    }
    const exhausted = attempts >= this.#maxAttempts;
    const due = exhausted ? 0 : this.#now() + backOff(attempts);
    if (job.action === "delete") {
      store.markMemoryDeleteFailure(job.archiveKey, job.segment, detail, exhausted, due);
    } else {
      this.#requeue(
        store,
        characterOfArchiveKey(job.archiveKey),
        { ...job, claim: inFlight.claim ?? job.claim },
        detail,
        exhausted,
        due,
      );
    }
    const counted = `(attempt ${String(attempts)}/${String(this.#maxAttempts)})`;
    if (exhausted) {
      shoreLog.error(
        `shore: hindsight archive ${job.action} exhausted retries for ${documentId} ` +
          `${counted}; giving up: ${detail}`,
      );
      return;
    }
    shoreLog.warn(
      `shore: hindsight archive ${job.action} failed for ${documentId} ` +
        `${counted}; retrying later: ${detail}`,
    );
  }

  async #operationStatus(
    registration: HindsightRetainRegistration,
    operation: string,
  ): Promise<{ status: string; error?: string }> {
    const payload = await this.#call(registration, GET_OPERATION_TOOL, {
      operation_id: operation,
    });
    const status = payload?.["status"];
    if (typeof status !== "string" || status === "") {
      throw new HindsightToolError(
        `hindsight ${GET_OPERATION_TOOL} returned no status: ${describe(payload)}`,
      );
    }
    const error = payload?.["error_message"];
    return {
      status,
      ...(typeof error === "string" && error !== "" ? { error } : {}),
    };
  }

  async #documentExists(
    registration: HindsightRetainRegistration,
    documentId: string,
  ): Promise<boolean> {
    let payload: Record<string, unknown> | undefined;
    try {
      payload = await this.#call(registration, GET_DOCUMENT_TOOL, { document_id: documentId });
    } catch (error) {
      if (error instanceof HindsightToolError && isMissing(error.message)) return false;
      throw error;
    }
    if (payload?.["id"] === documentId) return true;
    throw new HindsightToolError(
      `hindsight ${GET_DOCUMENT_TOOL} answered for ${documentId} with ${describe(payload)}`,
    );
  }

  async #findOperation(
    registration: HindsightRetainRegistration,
    documentId: string,
  ): Promise<string | undefined> {
    const payload = await this.#call(registration, LIST_OPERATIONS_TOOL, {
      limit: OPERATION_PAGE,
    });
    const operations = payload?.["operations"];
    if (!Array.isArray(operations)) return undefined;
    let fallback: string | undefined;
    for (const entry of operations) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as Record<string, unknown>;
      if (row["document_id"] !== documentId) continue;
      const status = row["status"];
      const id = row["id"];
      if (typeof status !== "string" || !IN_FLIGHT.has(status)) continue;
      if (typeof id !== "string" || id === "") continue;
      if (row["task_type"] === "batch_retain") return id;
      fallback ??= id;
    }
    return fallback;
  }

  async #delete(
    registration: HindsightRetainRegistration,
    documentId: string,
  ): Promise<void> {
    try {
      await this.#call(registration, DELETE_DOCUMENT_TOOL, { document_id: documentId });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!isMissing(detail)) throw error;
    }
  }

  async #call(
    registration: HindsightRetainRegistration,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const backend = this.#backend(registration.character);
    if (backend === undefined) {
      throw new HindsightToolError(
        `hindsight ${tool}: no memory backend is configured for '${registration.character}'`,
      );
    }
    const deadline = AbortSignal.timeout(registration.timeoutMs);
    const signal = AbortSignal.any([this.#stop.signal, deadline]);
    const raw = await settleBeforeAbort(
      backend.call(tool, args, signal),
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

function sameRegistration(
  a: HindsightRetainRegistration,
  b: HindsightRetainRegistration,
): boolean {
  return a.historyPath === b.historyPath &&
    a.userName === b.userName && a.possessivePronoun === b.possessivePronoun &&
    a.timeoutMs === b.timeoutMs;
}

function acceptedOperation(payload: Record<string, unknown> | undefined): string | undefined {
  if (payload?.["status"] !== "accepted") return undefined;
  const operation = payload["operation_id"];
  return typeof operation === "string" && operation.trim() !== "" ? operation : undefined;
}

function backOff(attempts: number): number {
  return Math.min(1_000 * 2 ** Math.min(attempts - 1, 20), MAX_RETRY_MS);
}

function isMissing(detail: string): boolean {
  return /\b(?:404|not found)\b/i.test(detail);
}

function describe(payload: Record<string, unknown> | undefined): string {
  if (payload === undefined) return "an unreadable reply";
  const text = JSON.stringify(payload);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

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
