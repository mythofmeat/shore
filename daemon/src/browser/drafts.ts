import type { ImageUpload } from "../protocol/ImageUpload.ts";

export interface DraftContent { text: string; images: ImageUpload[]; pending: boolean; options?: Record<string, unknown> }
export interface StoredDraft {
  id: string; conversation: string; revision: number; text: string; attachment: string | null;
  imageCount: number; bytes: number; updated: number; pending: boolean; options?: Record<string, unknown>;
}
const MAX_DRAFTS = 64;
const MAX_BYTES = 128 * 1024 * 1024;
let database: Promise<IDBDatabase> | undefined;
let ownership: Promise<boolean> | undefined;
const claimedDrafts = new Set<string>();
const sessions = new Map<string, BrowserDraft>();
const unsavedDrafts = new Set<BrowserDraft>();
let watchingUnload = false;

export function browserDraft(conversation: string): BrowserDraft {
  if (!watchingUnload) {
    watchingUnload = true;
    window.addEventListener("beforeunload", (event) => { if (unsavedDrafts.size > 0) event.preventDefault(); });
  }
  let session = sessions.get(conversation);
  if (session === undefined) { session = new BrowserDraft(conversation); sessions.set(conversation, session); }
  return session;
}

function separateClonedTab(): Promise<boolean> {
  ownership ??= (async () => {
    const prior = sessionStorage.getItem("shore.draft.tab");
    const owner = prior ?? crypto.randomUUID();
    if (navigator.locks === undefined) return true;
    const claim = async (id: string): Promise<boolean> => await new Promise((resolve, reject) => {
      void navigator.locks.request(`shore.draft.tab.${id}`, { ifAvailable: true }, async (lock) => {
        resolve(lock !== null);
        if (lock !== null) await new Promise<void>(() => {});
      }).catch(reject);
    });
    if (await claim(owner)) { sessionStorage.setItem("shore.draft.tab", owner); return false; }
    const fresh = crypto.randomUUID();
    await claim(fresh);
    sessionStorage.setItem("shore.draft.tab", fresh);
    return true;
  })();
  return ownership;
}

function open(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open("shore-drafts", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("drafts", { keyPath: "id" });
      request.result.createObjectStore("attachments");
    };
    request.onerror = () => { database = undefined; reject(request.error ?? new Error("Draft storage unavailable")); };
    request.onblocked = () => { blocked = true; reject(new Error("Close older Shore tabs to open draft storage")); };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  });
  const pending = database;
  void pending.catch(() => { if (database === pending) database = undefined; });
  return pending;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not read saved draft"));
  });
}

export async function storedDrafts(conversation?: string): Promise<StoredDraft[]> {
  const db = await open();
  const rows = await result(db.transaction("drafts").objectStore("drafts").getAll()) as StoredDraft[];
  return rows.filter((row) => conversation === undefined || row.conversation === conversation).sort((a, b) => b.updated - a.updated);
}

export async function readDraft(id: string, conversation: string): Promise<{ record: StoredDraft; content: DraftContent } | undefined> {
  const db = await open();
  const tx = db.transaction(["drafts", "attachments"]);
  const record = await result(tx.objectStore("drafts").get(id)) as StoredDraft | undefined;
  if (record === undefined || record.conversation !== conversation) return undefined;
  const images = record.attachment === null ? [] : await result(tx.objectStore("attachments").get(record.attachment)) as ImageUpload[] | undefined;
  if (images === undefined) throw new Error("Saved attachments are missing. The draft was kept for recovery.");
  return { record, content: { text: record.text, images, pending: record.pending, ...(record.options === undefined ? {} : { options: record.options }) } };
}

function cleanAttachments(tx: IDBTransaction, records: StoredDraft[]): void {
  const used = new Set(records.flatMap((row) => row.attachment === null ? [] : [row.attachment]));
  const cursor = tx.objectStore("attachments").openKeyCursor();
  cursor.onsuccess = () => {
    if (cursor.result === null) return;
    if (typeof cursor.result.key !== "string" || !used.has(cursor.result.key)) tx.objectStore("attachments").delete(cursor.result.key);
    cursor.result.continue();
  };
}

export async function discardDraft(record: StoredDraft): Promise<void> {
  const db = await open();
  return await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["drafts", "attachments"], "readwrite", { durability: "strict" });
    let failure: Error | undefined;
    const all = tx.objectStore("drafts").getAll();
    all.onsuccess = () => {
      const rows = all.result as StoredDraft[];
      if (rows.some((row) => row.id === record.id && row.revision !== record.revision)) {
        failure = new Error("This draft changed in another tab. Refresh the saved drafts before discarding it."); tx.abort(); return;
      }
      tx.objectStore("drafts").delete(record.id);
      cleanAttachments(tx, rows.filter((row) => row.id !== record.id));
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("Could not discard draft"));
  });
}

export class BrowserDraft {
  #id: string = crypto.randomUUID();
  #revision = 0;
  #attachment: string | null = null;
  #images: ImageUpload[] = [];
  #queue: Promise<void> = Promise.resolve();
  #latest: DraftContent | undefined;
  #sequence = 0;
  readonly #key: string;
  constructor(readonly conversation: string) { this.#key = `shore.draft.owner.v2.${conversation}`; }

  async load(): Promise<DraftContent> {
    await this.#queue;
    if (this.#latest !== undefined) return this.#latest;
    const sequence = this.#sequence;
    const cloned = await separateClonedTab();
    const id = sessionStorage.getItem(this.#key);
    const saved = id === null ? undefined : await readDraft(id, this.conversation);
    if (sequence !== this.#sequence) return await this.load();
    if (saved !== undefined) {
      if (cloned && !claimedDrafts.has(saved.record.id)) await this.save(saved.content);
      else {
        this.#id = saved.record.id; this.#revision = saved.record.revision;
        this.#attachment = saved.record.attachment; this.#images = saved.content.images;
      }
      return saved.content;
    }
    const legacy = localStorage.getItem(`shore.draft.v1.${this.conversation}`) ?? "";
    const content: DraftContent = { text: legacy, images: [], pending: false };
    if (legacy !== "" && (await storedDrafts(this.conversation)).length === 0) {
      await this.save(content);
      localStorage.removeItem(`shore.draft.v1.${this.conversation}`);
      return content;
    }
    return { text: "", images: [], pending: false };
  }

  save(content: DraftContent): Promise<void> {
    this.#latest = content;
    const sequence = ++this.#sequence;
    unsavedDrafts.add(this);
    const saved = this.#queue.then(async () => {
      await this.#write(content);
      if (sequence === this.#sequence) { this.#latest = undefined; unsavedDrafts.delete(this); }
    });
    this.#queue = saved.catch(() => {});
    return saved;
  }

  get unsaved(): boolean { return this.#latest !== undefined; }

  async #write(content: DraftContent): Promise<void> {
    const db = await open();
    const bytes = JSON.stringify(content.options ?? {}).length * 2 + content.text.length * 2 + content.images.reduce((sum, image) => sum + (image.data.length + image.filename.length + (image.mime_type?.length ?? 0)) * 2, 0);
    if (bytes > MAX_BYTES) throw new Error("This draft exceeds the 128 MiB browser storage limit");
    const saved = await new Promise<StoredDraft | undefined>((resolve, reject) => {
      const tx = db.transaction(["drafts", "attachments"], "readwrite", { durability: "strict" });
      let failure: Error | undefined;
      let next: StoredDraft | undefined;
      const all = tx.objectStore("drafts").getAll();
      all.onsuccess = () => {
        try {
          const rows = all.result as StoredDraft[];
          const previous = rows.find((row) => row.id === this.#id);
          const conflict = (previous?.revision ?? 0) !== this.#revision;
          const id = conflict ? crypto.randomUUID() : this.#id;
          const remaining = rows.filter((row) => row.id !== id);
          if (content.text !== "" || content.images.length > 0 || content.pending || Object.keys(content.options ?? {}).length > 0) {
            if (remaining.length >= MAX_DRAFTS || remaining.reduce((sum, row) => sum + row.bytes, bytes) > MAX_BYTES) {
              throw new Error("Draft storage is full. Discard a saved draft to save this one; your current text and attachments remain open.");
            }
            const attachment = content.images.length === 0 ? null : !conflict && content.images === this.#images && this.#attachment !== null
              ? this.#attachment : crypto.randomUUID();
            if (attachment !== null && attachment !== this.#attachment) tx.objectStore("attachments").put(content.images, attachment);
            next = { id, conversation: this.conversation, revision: conflict ? 1 : this.#revision + 1,
              text: content.text, attachment, imageCount: content.images.length, bytes, updated: Date.now(), pending: content.pending, ...(content.options === undefined ? {} : { options: content.options }) };
            tx.objectStore("drafts").put(next);
            remaining.push(next);
          } else if (!conflict) tx.objectStore("drafts").delete(id);
          cleanAttachments(tx, remaining);
        } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); tx.abort(); }
      };
      tx.oncomplete = () => resolve(next);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Could not save the draft"));
    });
    this.#id = saved?.id ?? crypto.randomUUID(); this.#revision = saved?.revision ?? 0;
    this.#attachment = saved?.attachment ?? null; this.#images = content.images;
    claimedDrafts.add(this.#id);
    sessionStorage.setItem(this.#key, this.#id);
  }
}
