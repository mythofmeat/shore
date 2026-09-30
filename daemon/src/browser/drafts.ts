import type { ImageUpload } from "../protocol/ImageUpload.ts";
import { randomUUID } from "./platform.ts";
import { restoredDraft } from "./request_forms.ts";

export interface DraftContent { text: string; images: ImageUpload[]; options?: Record<string, unknown> }
export interface StoredDraft {
  id: string; conversation: string; revision: number; text: string; attachment: string | null;
  imageCount: number; bytes: number; updated: number; options?: Record<string, unknown>;
}
export interface SendingMessage { rid: string; conversation: string; tab: string | null; text: string; images: ImageUpload[]; sent: number }
const MAX_DRAFTS = 64;
const MAX_BYTES = 128 * 1024 * 1024;
const TAB_LOCK = "shore.draft.tab.";
let database: Promise<IDBDatabase> | undefined;
let ownership: Promise<boolean> | undefined;
let tab: string | null = null;
const claimedDrafts = new Set<string>();
const sendingHere = new Set<string>();
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
    const owner = prior ?? randomUUID();
    if (navigator.locks === undefined) return true;
    const claim = async (id: string): Promise<boolean> => await new Promise((resolve, reject) => {
      void navigator.locks.request(`${TAB_LOCK}${id}`, { ifAvailable: true }, async (lock) => {
        resolve(lock !== null);
        if (lock !== null) await new Promise<void>(() => {});
      }).catch(reject);
    });
    if (await claim(owner)) { sessionStorage.setItem("shore.draft.tab", owner); tab = owner; return false; }
    const fresh = randomUUID();
    await claim(fresh);
    sessionStorage.setItem("shore.draft.tab", fresh);
    tab = fresh;
    return true;
  })();
  return ownership;
}

function open(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open("shore-drafts", 2);
    request.onupgradeneeded = () => {
      const stores = request.result.objectStoreNames;
      if (!stores.contains("drafts")) request.result.createObjectStore("drafts", { keyPath: "id" });
      if (!stores.contains("attachments")) request.result.createObjectStore("attachments");
      if (!stores.contains("sending")) request.result.createObjectStore("sending", { keyPath: "rid" });
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
  return { record, content: { text: record.text, images, ...(record.options === undefined ? {} : { options: record.options }) } };
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

class SendingTaken extends Error {
  constructor() { super("Another tab already put this message back in its message box"); }
}

async function readSending(rid: string): Promise<SendingMessage | undefined> {
  const db = await open();
  return await result(db.transaction("sending").objectStore("sending").get(rid)) as SendingMessage | undefined;
}

export async function forgetSending(rid: string): Promise<void> {
  sendingHere.delete(rid);
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("sending", "readwrite", { durability: "strict" });
    tx.objectStore("sending").delete(rid);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Could not update the sent message"));
  });
}

export function handOverSending(rid: string): void { sendingHere.delete(rid); }

export async function unclaimedSending(): Promise<SendingMessage[]> {
  await separateClonedTab();
  const db = await open();
  const rows = (await result(db.transaction("sending").objectStore("sending").getAll()) as SendingMessage[]).filter((row) => !sendingHere.has(row.rid));
  if (rows.length === 0 || navigator.locks === undefined) return rows;
  const held = new Set(((await navigator.locks.query()).held ?? []).map((lock) => lock.name));
  return rows.filter((row) => row.tab === null || row.tab === tab || !held.has(`${TAB_LOCK}${row.tab}`));
}

export async function withSendingLock<T>(work: () => Promise<T>): Promise<T> {
  return navigator.locks === undefined ? await work() : await navigator.locks.request("shore.draft.sending", work);
}

export class BrowserDraft {
  #id: string = randomUUID();
  #revision = 0;
  #attachment: string | null = null;
  #images: ImageUpload[] = [];
  #queue: Promise<void> = Promise.resolve();
  #current: DraftContent | undefined;
  #saving = false;
  readonly #listeners = new Set<(content: DraftContent) => void>();
  #sequence = 0;
  readonly #key: string;
  constructor(readonly conversation: string) { this.#key = `shore.draft.owner.v2.${conversation}`; }

  async load(): Promise<DraftContent> {
    await this.#queue;
    if (this.#current !== undefined) return this.#current;
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
    const content: DraftContent = { text: legacy, images: [] };
    if (legacy !== "" && (await storedDrafts(this.conversation)).length === 0) {
      await this.save(content);
      localStorage.removeItem(`shore.draft.v1.${this.conversation}`);
      return content;
    }
    return { text: "", images: [] };
  }

  save(content: DraftContent): Promise<void> { return this.#save(content); }

  send(rid: string, sent: DraftContent): Promise<void> {
    sendingHere.add(rid);
    const message: SendingMessage = { rid, conversation: this.conversation, tab, text: sent.text, images: sent.images, sent: Date.now() };
    return this.#save({ ...sent, text: "", images: [] }, { put: message });
  }

  async restore(rid: string, fallback?: DraftContent): Promise<{ restored: boolean; dropped: number }> {
    const loaded = await this.load();
    const stored = fallback === undefined ? await readSending(rid) : await readSending(rid).catch(() => undefined);
    const sent = stored ?? fallback;
    if (sent === undefined) { sendingHere.delete(rid); return { restored: false, dropped: 0 }; }
    const before = this.#current ?? loaded;
    const { content, dropped } = restoredDraft(sent, before);
    try { await this.#save(content, stored === undefined ? undefined : { take: rid }); } catch (error) {
      if (!(error instanceof SendingTaken)) throw error;
      sendingHere.delete(rid);
      if (this.#current === content) await this.#save(before);
      return { restored: false, dropped: 0 };
    }
    sendingHere.delete(rid);
    return { restored: true, dropped };
  }

  #save(content: DraftContent, sending?: { put?: SendingMessage; take?: string }): Promise<void> {
    this.#current = content;
    const sequence = ++this.#sequence;
    this.#saving = true;
    unsavedDrafts.add(this);
    const saved = this.#queue.then(async () => {
      try {
        await this.#write(content, sending);
        if (sequence === this.#sequence) unsavedDrafts.delete(this);
      } finally {
        if (sequence === this.#sequence) {
          this.#saving = false;
          for (const listener of this.#listeners) listener(content);
        }
      }
    });
    this.#queue = saved.catch(() => {});
    for (const listener of this.#listeners) listener(content);
    return saved;
  }

  get current(): DraftContent | undefined { return this.#current; }
  get saving(): boolean { return this.#saving; }

  subscribe(listener: (content: DraftContent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  get unsaved(): boolean { return unsavedDrafts.has(this); }

  async #write(content: DraftContent, sending?: { put?: SendingMessage; take?: string }): Promise<void> {
    const db = await open();
    const bytes = JSON.stringify(content.options ?? {}).length * 2 + content.text.length * 2 + content.images.reduce((sum, image) => sum + (image.data.length + image.filename.length + (image.mime_type?.length ?? 0)) * 2, 0);
    if (bytes > MAX_BYTES) throw new Error("This draft exceeds the 128 MiB browser storage limit");
    const saved = await new Promise<StoredDraft | undefined>((resolve, reject) => {
      const tx = db.transaction(["drafts", "attachments", "sending"], "readwrite", { durability: "strict" });
      let failure: Error | undefined;
      let next: StoredDraft | undefined;
      const unsent = tx.objectStore("sending");
      const taken = sending?.take === undefined ? undefined : unsent.get(sending.take);
      const all = tx.objectStore("drafts").getAll();
      all.onsuccess = () => {
        try {
          if (taken !== undefined && taken.result === undefined) throw new SendingTaken();
          const rows = all.result as StoredDraft[];
          const previous = rows.find((row) => row.id === this.#id);
          const conflict = (previous?.revision ?? 0) !== this.#revision;
          const id = conflict ? randomUUID() : this.#id;
          const remaining = rows.filter((row) => row.id !== id);
          if (content.text !== "" || content.images.length > 0 || Object.keys(content.options ?? {}).length > 0) {
            if (remaining.length >= MAX_DRAFTS || remaining.reduce((sum, row) => sum + row.bytes, bytes) > MAX_BYTES) {
              throw new Error("Draft storage is full. Discard a saved draft to save this one; your current text and attachments remain open.");
            }
            const attachment = content.images.length === 0 ? null : !conflict && content.images === this.#images && this.#attachment !== null
              ? this.#attachment : randomUUID();
            if (attachment !== null && attachment !== this.#attachment) tx.objectStore("attachments").put(content.images, attachment);
            next = { id, conversation: this.conversation, revision: conflict ? 1 : this.#revision + 1,
              text: content.text, attachment, imageCount: content.images.length, bytes, updated: Date.now(), ...(content.options === undefined ? {} : { options: content.options }) };
            tx.objectStore("drafts").put(next);
            remaining.push(next);
          } else if (!conflict) tx.objectStore("drafts").delete(id);
          cleanAttachments(tx, remaining);
          if (sending?.put !== undefined) unsent.put(sending.put);
          if (sending?.take !== undefined) unsent.delete(sending.take);
        } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); tx.abort(); }
      };
      tx.oncomplete = () => resolve(next);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Could not save the draft"));
    });
    this.#id = saved?.id ?? randomUUID(); this.#revision = saved?.revision ?? 0;
    this.#attachment = saved?.attachment ?? null; this.#images = content.images;
    claimedDrafts.add(this.#id);
    sessionStorage.setItem(this.#key, this.#id);
  }
}
