import { describe, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveSpool } from "../src/commands/archive_spool.ts";
import { outcomeOf } from "./support/outcome.ts";

const place = () => join(mkdtempSync(join(tmpdir(), "shore-spool-")), "transfers");
const bytes = (size: number) => new Uint8Array(size).map((_, at) => at % 251);

async function spooledDownload(spool: ArchiveSpool, owner: string, content: Uint8Array): Promise<string> {
  const entry = await spool.reserve(owner);
  await Bun.write(entry.file, content);
  spool.publish(entry, "download", content.length);
  return entry.id;
}

describe("the archive spool", () => {
  test("takes an upload in pieces and gives it back to the device that sent it, once", async () => {
    const directory = place();
    const spool = new ArchiveSpool(directory);
    const sent = bytes(3 * 1024 * 1024 + 5);
    const pieces = (async function* () { for (let at = 0; at < sent.length; at += 700_000) yield sent.subarray(at, at + 700_000); })();
    const upload = await spool.receive("laptop", pieces);
    expect(upload.bytes).toBe(sent.length);
    expect(() => spool.claim("phone", upload.transfer)).toThrow("No upload transfer");
    expect(() => spool.send("laptop", upload.transfer)).toThrow("No download transfer");
    const entry = spool.claim("laptop", upload.transfer);
    expect(new Uint8Array(await Bun.file(entry.file).arrayBuffer())).toEqual(sent);
    expect(() => spool.claim("laptop", upload.transfer)).toThrow("No upload transfer");
    await spool.discard(entry);
    expect(readdirSync(directory)).toEqual([]);
  });

  test("refuses an empty upload and keeps nothing of it", async () => {
    const directory = place();
    const spool = new ArchiveSpool(directory);
    expect(await outcomeOf(spool.receive("laptop", new Blob([]).stream()))).toThrow("An upload needs at least one byte");
    expect(readdirSync(directory)).toEqual([]);
  });

  test("an upload that breaks off midway keeps nothing of it", async () => {
    const directory = place();
    const spool = new ArchiveSpool(directory);
    const broken = (async function* () { yield bytes(10); throw new Error("the client went away"); })();
    expect(await outcomeOf(spool.receive("laptop", broken))).toThrow("the client went away");
    expect(readdirSync(directory)).toEqual([]);
  });

  test("holds at most four transfers for one device, while others still have room", async () => {
    const spool = new ArchiveSpool(place());
    for (let held = 0; held < 4; held += 1) await spool.receive("laptop", new Blob(["x"]).stream());
    expect(await outcomeOf(spool.receive("laptop", new Blob(["x"]).stream()))).toThrow("at most 4 archive transfers");
    expect((await spool.receive("phone", new Blob(["x"]).stream())).bytes).toBe(1);
  });

  test("streams a download whole and removes it after, so it can't be fetched twice", async () => {
    const directory = place();
    const spool = new ArchiveSpool(directory);
    const content = bytes(2 * 1024 * 1024 + 3);
    const id = await spooledDownload(spool, "laptop", content);
    expect(() => spool.send("phone", id)).toThrow("No download transfer");
    const sent = spool.send("laptop", id);
    expect(sent.bytes).toBe(content.length);
    expect(() => spool.send("laptop", id)).toThrow("No download transfer");
    expect(new Uint8Array(await new Response(sent.stream).arrayBuffer())).toEqual(content);
    expect(readdirSync(directory)).toEqual([]);
  });

  test("a download given up halfway, or whose file came up short, is removed all the same", async () => {
    const directory = place();
    const spool = new ArchiveSpool(directory);
    const cancelled = spool.send("laptop", await spooledDownload(spool, "laptop", bytes(3 * 1024 * 1024)));
    const reader = cancelled.stream.getReader();
    expect((await reader.read()).value?.length).toBe(1024 * 1024);
    await reader.cancel();
    const shortId = await spooledDownload(spool, "laptop", bytes(10));
    const entries = readdirSync(directory);
    expect(entries).toEqual([shortId]);
    truncateSync(join(directory, shortId, "archive.tar"), 0);
    expect(await outcomeOf(new Response(spool.send("laptop", shortId).stream).arrayBuffer())).toThrow("Archive ended before its recorded size");
    expect(readdirSync(directory)).toEqual([]);
  });

  test("starts from an empty folder of its own, making any missing parents, readable by its owner alone", async () => {
    const left = place();
    mkdirSync(join(left, "old"), { recursive: true });
    writeFileSync(join(left, "old", "archive.tar"), "from the last run");
    const upload = await new ArchiveSpool(left).receive("laptop", new Blob(["x"]).stream());
    expect(readdirSync(left)).toEqual([upload.transfer]);
    const directory = join(place(), "deeper", "still");
    const kept = await new ArchiveSpool(directory).receive("laptop", new Blob(["x"]).stream());
    expect([directory, join(directory, kept.transfer), join(directory, kept.transfer, "archive.tar")].map((path) => statSync(path).mode & 0o777)).toEqual([0o700, 0o700, 0o600]);
  });

  test("a transfer is swept once it has sat idle longer than a quarter of an hour, and not a moment before", async () => {
    const directory = place();
    const spool = new ArchiveSpool(directory);
    try {
      setSystemTime(new Date(1_000_000));
      await spool.receive("laptop", new Blob(["x"]).stream());
      setSystemTime(new Date(1_000_000 + 15 * 60_000));
      await spool.sweep();
      expect(readdirSync(directory)).toHaveLength(1);
      setSystemTime(new Date(1_000_001 + 15 * 60_000));
      await spool.sweep();
      expect(readdirSync(directory)).toEqual([]);
    } finally { setSystemTime(); }
  });

  test("stops its minute sweeper once the last transfer is collected, whichever way it goes", async () => {
    const set = spyOn(globalThis, "setInterval");
    const cleared = spyOn(globalThis, "clearInterval");
    try {
      const spool = new ArchiveSpool(place());
      const sweeper = () => set.mock.results[set.mock.calls.findLastIndex((call) => call[1] === 60_000)]?.value as ReturnType<typeof setInterval>;
      const upload = await spool.receive("laptop", new Blob(["x"]).stream());
      spool.claim("laptop", upload.transfer);
      expect(cleared).toHaveBeenCalledWith(sweeper());
      cleared.mockClear();
      spool.send("laptop", await spooledDownload(spool, "laptop", bytes(5)));
      expect(cleared).toHaveBeenCalledWith(sweeper());
    } finally {
      set.mockRestore();
      cleared.mockRestore();
    }
  });

  test("a download stops at the size its archive was recorded at", async () => {
    const spool = new ArchiveSpool(place());
    const content = bytes(2 * 1024 * 1024);
    const entry = await spool.reserve("laptop");
    await Bun.write(entry.file, content);
    spool.publish(entry, "download", 1024 * 1024 + 512 * 1024);
    expect(new Uint8Array(await new Response(spool.send("laptop", entry.id).stream).arrayBuffer())).toEqual(content.subarray(0, 1024 * 1024 + 512 * 1024));
  });

  test("a download whose archive has gone fails with the missing archive", async () => {
    const directory = place();
    const spool = new ArchiveSpool(directory);
    const id = await spooledDownload(spool, "laptop", bytes(10));
    rmSync(join(directory, id), { recursive: true });
    expect(await outcomeOf(new Response(spool.send("laptop", id).stream).arrayBuffer())).toThrow("archive.tar");
  });

  test("sweeps by itself once a minute while it holds anything, and a transfer left idle goes", async () => {
    const directory = place();
    const spool = new ArchiveSpool(directory, 10);
    jest.useFakeTimers();
    try {
      const upload = await spool.receive("laptop", new Blob(["x"]).stream());
      jest.setSystemTime(Date.now() + 61_000);
      jest.advanceTimersByTime(60_000);
      jest.useRealTimers();
      for (let tries = 0; tries < 50 && readdirSync(directory).length > 0; tries += 1) await Bun.sleep(10);
      expect(readdirSync(directory)).toEqual([]);
      expect(() => spool.claim("laptop", upload.transfer)).toThrow("No upload transfer");
    } finally { jest.useRealTimers(); }
  });
});
