import { constants } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, LocalPeer } from "../swp/server.ts";
import type { WebSession } from "./auth.ts";
import type { WebArchiveInfo } from "../protocol/WebArchiveInfo.ts";
import type { WebArchiveList } from "../protocol/WebArchiveList.ts";
import type { WebArchiveResult } from "../protocol/WebArchiveResult.ts";
import type { OperationInput } from "../operations/types.ts";
import { parseOperationInput, parseOperationResult } from "../operations/contracts.ts";
import { securityHeaders } from "./policy.ts";

export const ARCHIVE_TRANSFER_LIMITS = {
  uploadBytes: 64 * 1024 * 1024, expandedBytes: 256 * 1024 * 1024, entries: 20_000,
  totalBytes: 256 * 1024 * 1024, artifacts: 32, perSession: 4,
  lifetimeMs: 15 * 60_000, requestMs: 60_000, operationMs: 5 * 60_000,
};
export type ArchiveTransferLimits = typeof ARCHIVE_TRANSFER_LIMITS;

export class ArchiveTransferError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

class ConfirmedArchiveFailure extends Error {}
type ArchiveOperation = "export_character" | "import_character";
interface Artifact {
  owner: WebSession;
  info: WebArchiveInfo;
  directory: Promise<string>;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
  reserved: number;
  work?: Promise<void>;
  download?: Promise<void>;
  downloading: boolean;
}

export class ArchiveTransfers {
  readonly #records = new Map<string, Artifact>();
  readonly #cleanup = new Set<Promise<void>>();
  readonly #limits: ArchiveTransferLimits;
  #commands = 0;
  #closed = false;

  constructor(readonly server: Server, readonly canAttach: () => boolean, limits: Partial<ArchiveTransferLimits> = {}) {
    this.#limits = { ...ARCHIVE_TRANSFER_LIMITS, ...limits };
    if (Object.values(this.#limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error("Archive transfer limits must be positive safe integers");
  }

  get activePeers(): number { return this.#commands; }

  #owned(owner: WebSession, id: string): Artifact {
    const record = this.#records.get(id);
    if (owner.signal.aborted || record === undefined || record.owner.id !== owner.id || record.abort.signal.aborted) throw new ArchiveTransferError(404, "Archive transfer is missing or expired");
    return record;
  }

  list(owner: WebSession): WebArchiveList {
    return { archives: [...this.#records.values()].filter((record) => record.owner.id === owner.id && !record.abort.signal.aborted).map((record) => ({ ...record.info })), max_upload_bytes: this.#limits.uploadBytes, max_expanded_bytes: this.#limits.expandedBytes };
  }

  get(owner: WebSession, id: string): WebArchiveInfo { return { ...this.#owned(owner, id).info }; }

  #allocate(owner: WebSession, filename: string, phase: WebArchiveInfo["phase"]): Artifact {
    if (this.#closed || owner.signal.aborted) throw new ArchiveTransferError(401, "Sign in again before transferring archives");
    const existing = [...this.#records.values()];
    if (existing.length >= this.#limits.artifacts || existing.filter((record) => record.owner.id === owner.id).length >= this.#limits.perSession || existing.reduce((sum, record) => sum + record.reserved, 0) + this.#limits.uploadBytes > this.#limits.totalBytes) throw new ArchiveTransferError(429, "Archive transfer capacity reached; remove a completed transfer first");
    const id = crypto.randomUUID();
    const abort = new AbortController();
    const expire = () => { void this.#remove(record); };
    const record: Artifact = {
      owner, info: { id, filename, bytes: 0, expires_at: Date.now() + this.#limits.lifetimeMs, phase, downloadable: false },
      directory: mkdtemp(join(tmpdir(), "shore-web-archive-")), abort, downloading: false,
      timer: setTimeout(expire, this.#limits.lifetimeMs), reserved: this.#limits.uploadBytes,
      detach: () => owner.signal.removeEventListener("abort", expire),
    };
    void record.directory.catch(() => {});
    owner.signal.addEventListener("abort", expire, { once: true });
    this.#records.set(id, record);
    return record;
  }

  async #path(record: Artifact): Promise<string> {
    const directory = await record.directory;
    record.abort.signal.throwIfAborted();
    return join(directory, "archive.tar.gz");
  }

  #remove(record: Artifact): Promise<void> {
    if (this.#records.get(record.info.id) !== record) return Promise.resolve();
    this.#records.delete(record.info.id);
    clearTimeout(record.timer); record.detach(); record.abort.abort();
    const cleanup = (async () => {
      await record.work?.catch(() => {});
      await record.download?.catch(() => {});
      const directory = await record.directory.catch(() => undefined);
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    })();
    this.#cleanup.add(cleanup);
    void cleanup.finally(() => this.#cleanup.delete(cleanup)).catch(() => {});
    return cleanup;
  }

  async remove(owner: WebSession, id: string): Promise<void> {
    const record = this.#owned(owner, id);
    if (["uploading", "exporting", "importing"].includes(record.info.phase) || record.downloading) throw new ArchiveTransferError(409, "Wait for the active transfer to finish before removing it");
    await this.#remove(record);
  }

  async upload(owner: WebSession, request: Request): Promise<WebArchiveInfo> {
    if (request.headers.get("content-type") !== "application/octet-stream") throw new ArchiveTransferError(400, "Upload archive bytes as application/octet-stream");
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > this.#limits.uploadBytes) throw new ArchiveTransferError(413, "Archive exceeds the upload size limit");
    let filename: string;
    try { filename = decodeURIComponent(request.headers.get("x-shore-filename") ?? "character.shore.tar.gz").split(/[\\/]/).at(-1) ?? ""; }
    catch { throw new ArchiveTransferError(400, "Invalid archive filename"); }
    if (filename.length === 0 || filename.length > 200) throw new ArchiveTransferError(400, "Invalid archive filename");
    for (const character of filename) if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) throw new ArchiveTransferError(400, "Invalid archive filename");
    const record = this.#allocate(owner, filename, "uploading");
    record.work = (async () => {
      const file = await open(await this.#path(record), "wx", 0o600);
      const reader = request.body?.getReader();
      const signal = AbortSignal.any([request.signal, record.abort.signal, AbortSignal.timeout(this.#limits.requestMs)]);
      const cancel = () => { void reader?.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        if (reader === undefined) throw new ArchiveTransferError(400, "Choose an archive file");
        let bytes = 0;
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) break;
          const chunk: unknown = next.value;
          if (!(chunk instanceof Uint8Array)) throw new ArchiveTransferError(400, "Expected archive bytes");
          bytes += chunk.byteLength;
          if (bytes > this.#limits.uploadBytes) throw new ArchiveTransferError(413, "Archive exceeds the upload size limit");
          for (let offset = 0; offset < chunk.byteLength;) {
            const written = await file.write(chunk, offset, chunk.byteLength - offset);
            if (written.bytesWritten === 0) throw new Error("Could not store archive bytes");
            offset += written.bytesWritten;
          }
        }
        if (bytes === 0 || (declared !== 0 && bytes !== declared)) throw new ArchiveTransferError(400, "Archive upload is empty or incomplete");
        record.info.bytes = bytes; record.reserved = bytes;
      } finally {
        signal.removeEventListener("abort", cancel);
        await reader?.cancel().catch(() => {}); reader?.releaseLock(); await file.close();
      }
      record.abort.signal.throwIfAborted();
      record.info.phase = "ready";
    })();
    try { await record.work; return { ...record.info }; }
    catch (error) { await this.#remove(record); throw error; }
  }

  #available(): void {
    if (this.#commands >= 1 || !this.canAttach()) throw new ArchiveTransferError(429, "Another archive operation is running; try again after it completes");
  }

  export(owner: WebSession, character: string): WebArchiveInfo {
    this.#available();
    parseOperationInput("export_character", { character, output: "/controlled/archive.tar.gz" });
    const filename = `${character.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100)}.shore.tar.gz`;
    const record = this.#allocate(owner, filename, "exporting");
    this.#start(record, "export_character", async () => ({ character, output: await this.#path(record) }));
    return { ...record.info };
  }

  import(owner: WebSession, id: string): WebArchiveInfo {
    const record = this.#owned(owner, id);
    if (record.info.phase !== "ready" || record.info.downloadable) return { ...record.info };
    this.#available();
    record.info.phase = "importing";
    this.#start(record, "import_character", async () => ({ archive: await this.#path(record) }));
    return { ...record.info };
  }

  #start<N extends ArchiveOperation>(record: Artifact, name: N, input: () => Promise<OperationInput<N>>): void {
    this.#commands += 1;
    record.work = (async () => {
      try {
        const result = await this.#execute(record, name, await input());
        record.info.result = result;
        if (name === "export_character") {
          const size = (await stat(await this.#path(record))).size;
          if (size > this.#limits.uploadBytes) throw new ConfirmedArchiveFailure("Export exceeds the browser download size limit");
          record.info.bytes = size; record.reserved = size;
          record.info.phase = "ready"; record.info.downloadable = true;
        } else {
          record.info.phase = "imported";
          await rm(await record.directory, { recursive: true, force: true }); record.reserved = 0;
        }
      } catch (error) {
        record.info.phase = name === "import_character" && !(error instanceof ConfirmedArchiveFailure) ? "uncertain" : "failed";
        record.info.error = (error instanceof Error ? error.message : "Archive operation failed").slice(0, 4096);
        await record.directory.then((directory) => rm(directory, { recursive: true, force: true })).catch(() => {});
        record.reserved = 0;
      } finally { this.#commands -= 1; }
    })();
    void record.work.catch(() => {});
  }

  async #execute<N extends ArchiveOperation>(record: Artifact, name: N, args: OperationInput<N>): Promise<WebArchiveResult> {
    const controller = new AbortController();
    const signal = AbortSignal.any([record.abort.signal, controller.signal, AbortSignal.timeout(this.#limits.operationMs)]);
    let peer: LocalPeer | undefined;
    try {
      peer = await this.server.attachLocal({ clientType: "web", clientName: "Browser archive transfer", character: null, capabilities: ["request-lifecycle"], signal,
        archiveLimits: { bytes: this.#limits.expandedBytes, entries: this.#limits.entries },
        outboundLimits: { messages: 32, bytes: 1024 * 1024, onOverflow: () => controller.abort(new Error("Archive response exceeded its delivery limit")) },
      });
      const rid = `archive-${record.info.id}`;
      const events = peer.events();
      let output: unknown;
      let received = false;
      const sent = peer.send({ type: "command", name, args, rid });
      void sent.catch(() => controller.abort(new Error("Archive command delivery failed")));
      for await (const frame of events) {
        if (!("rid" in frame) || frame.rid !== rid) continue;
        if (frame.type === "command_output") {
          if (received || frame.name !== name) throw new Error("Unexpected archive response");
          output = frame.data; received = true;
        }
        if (frame.type === "request_finished") {
          await sent;
          if (frame.outcome === "failed") throw new ConfirmedArchiveFailure(frame.error?.message ?? "Archive operation failed");
          if (frame.outcome !== "completed" || !received) throw new Error("Archive outcome could not be confirmed; inspect the character list before trying again");
          return name === "export_character" ? { name: "export_character", data: parseOperationResult("export_character", output) } : { name: "import_character", data: parseOperationResult("import_character", output) };
        }
      }
      throw new Error("Archive connection ended before its outcome was confirmed");
    } finally { await peer?.detach(); }
  }

  async download(owner: WebSession, id: string, request: Request): Promise<Response> {
    const record = this.#owned(owner, id);
    if (!record.info.downloadable || record.info.phase !== "ready" || record.downloading) throw new ArchiveTransferError(409, "Archive is not ready for download");
    record.downloading = true;
    const completed = Promise.withResolvers<void>();
    record.download = completed.promise;
    const release = () => { record.downloading = false; completed.resolve(); };
    const file = await (async () => {
      try { return await open(await this.#path(record), constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { release(); throw error; }
    })();
    const attributes = await (async () => {
      try {
        record.abort.signal.throwIfAborted();
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size !== record.info.bytes || metadata.size > this.#limits.uploadBytes) throw new ArchiveTransferError(409, "Archive changed; prepare another export");
        return metadata;
      } catch (error) { try { await file.close(); } finally { release(); } throw error; }
    })();
    let offset = 0;
    let finished = false;
    const signal = AbortSignal.any([record.abort.signal, request.signal, AbortSignal.timeout(this.#limits.requestMs)]);
    let detach = () => {};
    const close = async (complete: boolean) => {
      if (finished) return;
      finished = true; detach();
      try { await file.close(); } finally { release(); }
      if (complete) await this.#remove(record);
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => { controller.error(new Error("Archive download interrupted")); void close(false).catch(() => {}); };
        signal.addEventListener("abort", abort, { once: true }); detach = () => signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
      },
      async pull(controller) {
        if (finished) return;
        try {
          signal.throwIfAborted();
          const buffer = new Uint8Array(Math.min(64 * 1024, attributes.size - offset));
          if (buffer.byteLength === 0) { controller.close(); await close(true); return; }
          const read = await file.read(buffer, 0, buffer.byteLength, offset);
          if (read.bytesRead === 0) throw new Error("Archive download was incomplete");
          offset += read.bytesRead; controller.enqueue(buffer.subarray(0, read.bytesRead));
        } catch (error) { if (!finished) controller.error(error); await close(false); }
      },
      async cancel() { await close(false); },
    });
    const headers = securityHeaders();
    headers.set("content-type", "application/gzip"); headers.set("content-length", String(attributes.size));
    headers.set("content-disposition", `attachment; filename="character.shore.tar.gz"; filename*=UTF-8''${encodeURIComponent(record.info.filename).replaceAll("'", "%27")}`);
    return new Response(stream, { headers });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#records.values()].map((record) => this.#remove(record)));
    await Promise.allSettled(this.#cleanup);
  }
}
