import { withStorage, writeState } from "../src/storage/store.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";

import { EventMap, EVENT_MAP_CAP, type MappedEvent } from "../src/connections/matrix/event_map.ts";
import { ViewPrefs } from "../src/connections/matrix/prefs.ts";
import { RoomBindings } from "../src/connections/matrix/rooms.ts";

const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "shore-matrix-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const reply = (overrides: Partial<MappedEvent> = {}): MappedEvent => ({
  msgId: "m1",
  roomId: "!room:example.com",
  eventId: "$e1",
  origin: "assistant",
  content: "hello",
  ...overrides,
});

const roomOf = (rooms: RoomBindings, character: string): string | undefined =>
  new Map(rooms.entries()).get(character);

describe("room bindings", () => {
  test("a character and a room point at each other", () => {
    const rooms = new RoomBindings();
    rooms.bind("!room1:example.com", "alice");
    expect(rooms.characterForRoom("!room1:example.com")).toBe("alice");
    expect(roomOf(rooms, "alice")).toBe("!room1:example.com");
    expect(rooms.isBound("!room1:example.com")).toBe(true);
  });

  test("binding a character elsewhere releases its old room", () => {
    const rooms = new RoomBindings();
    rooms.bind("!room1:example.com", "alice");
    rooms.bind("!room2:example.com", "alice");
    expect(rooms.characterForRoom("!room1:example.com")).toBeUndefined();
    expect(roomOf(rooms, "alice")).toBe("!room2:example.com");
  });

  test("binding a room to someone else releases its old character", () => {
    const rooms = new RoomBindings();
    rooms.bind("!room1:example.com", "alice");
    rooms.bind("!room1:example.com", "bob");
    expect(rooms.characterForRoom("!room1:example.com")).toBe("bob");
    expect(roomOf(rooms, "alice")).toBeUndefined();
  });

  test("unbinding clears both directions, and unbinding nothing is quiet", () => {
    const rooms = new RoomBindings();
    rooms.bind("!room1:example.com", "alice");
    rooms.unbindRoom("!room1:example.com");
    expect(rooms.characterForRoom("!room1:example.com")).toBeUndefined();
    expect(roomOf(rooms, "alice")).toBeUndefined();
    expect(() => rooms.unbindRoom("!nothing:example.com")).not.toThrow();
  });

  test("bindings survive a restart", () => {
    const path = join(scratch(), "rooms.json");
    const first = new RoomBindings(path);
    first.bind("!room1:example.com", "alice");
    first.bind("!room2:example.com", "bob");

    const second = new RoomBindings(path);
    expect(second.entries()).toEqual([
      ["alice", "!room1:example.com"],
      ["bob", "!room2:example.com"],
    ]);
  });

  test("an unreadable sidecar starts empty rather than throwing", () => {
    const path = join(scratch(), "rooms.json");
    writeState(dirname(path), basename(path), "{ not json");
    expect(new RoomBindings(path).entries()).toEqual([]);
  });
});

describe("the daemon-message to Matrix-event map", () => {
  test("both directions resolve, and re-recording a msg_id displaces the old event", () => {
    const map = new EventMap();
    map.record(reply());
    expect(map.byMsgId("m1")?.eventId).toBe("$e1");
    expect(map.byEventId("$e1")?.msgId).toBe("m1");

    map.record(reply({ eventId: "$e2" }));
    expect(map.byMsgId("m1")?.eventId).toBe("$e2");
    expect(map.byEventId("$e1")).toBeUndefined();
  });

  test("the latest reply in a room skips mirrored and Matrix-authored events", () => {
    const map = new EventMap();
    map.record(reply({ msgId: "m1", eventId: "$e1" }));
    map.record(reply({ msgId: "m2", eventId: "$e2", origin: "mirrored_user" }));
    map.record(reply({ msgId: "m3", eventId: "$e3", origin: "matrix_user" }));
    expect(map.latestReplyInRoom("!room:example.com")?.msgId).toBe("m1");

    map.record(reply({ msgId: "m4", eventId: "$e4" }));
    expect(map.latestReplyInRoom("!room:example.com")?.msgId).toBe("m4");
    expect(map.latestReplyInRoom("!elsewhere:example.com")).toBeUndefined();
  });

  test("content updates in place, and an event can be removed", () => {
    const map = new EventMap();
    map.record(reply());
    map.updateContent("m1", "edited");
    expect(map.byMsgId("m1")?.content).toBe("edited");

    expect(map.removeEvent("$e1")?.msgId).toBe("m1");
    expect(map.byEventId("$e1")).toBeUndefined();
    expect(map.byMsgId("m1")).toBeUndefined();
    expect(map.removeEvent("$gone")).toBeUndefined();
  });

  test("the oldest entries fall off past the cap", () => {
    const map = new EventMap();
    for (let i = 0; i < EVENT_MAP_CAP + 5; i += 1) {
      map.record(reply({ msgId: `m${i}`, eventId: `$e${i}` }));
    }
    expect(map.byMsgId("m0")).toBeUndefined();
    expect(map.byMsgId("m4")).toBeUndefined();
    expect(map.byMsgId("m5")).toBeDefined();
    expect(map.byMsgId(`m${EVENT_MAP_CAP + 4}`)).toBeDefined();
  });

  test("mappings survive a restart, and a corrupt entry is dropped not fatal", () => {
    const path = join(scratch(), "events.json");
    const first = new EventMap(path);
    first.record(reply());

    expect(new EventMap(path).byMsgId("m1")?.eventId).toBe("$e1");

    writeState(dirname(path), basename(path), JSON.stringify({ entries: [reply(), { msgId: 7 }] }));
    const recovered = new EventMap(path);
    expect(recovered.byMsgId("m1")).toBeDefined();
  });
});

describe("per-room view preferences", () => {
  test("everything is off until set, and an unknown key sets nothing", () => {
    const prefs = new ViewPrefs();
    expect(prefs.room("!room:example.com")).toEqual({
      thinking: false,
      tools: false,
      usage: false,
    });
    expect(prefs.set("!room:example.com", "nosuchkey", true)).toBeUndefined();
  });

  test("an explicit value sets, and no value toggles", () => {
    const prefs = new ViewPrefs();
    expect(prefs.set("!room:example.com", "thinking", true)).toBe(true);
    expect(prefs.room("!room:example.com").thinking).toBe(true);
    expect(prefs.set("!room:example.com", "thinking", undefined)).toBe(false);
    expect(prefs.set("!room:example.com", "thinking", undefined)).toBe(true);
  });

  test("rooms do not share preferences, and they survive a restart", () => {
    const path = join(scratch(), "prefs.json");
    const first = new ViewPrefs(path);
    first.set("!a:example.com", "tools", true);
    expect(first.room("!b:example.com").tools).toBe(false);

    const second = new ViewPrefs(path);
    expect(second.room("!a:example.com").tools).toBe(true);
    expect(second.room("!b:example.com").tools).toBe(false);
  });
});

describe("sidecar durability", () => {
  test("a corrupt file is set aside rather than silently read as empty", () => {
    const root = scratch();
    const path = join(root, "bindings.json");
    writeState(dirname(path), basename(path), "{ not json at all");

    const rooms = new RoomBindings(path);
    expect(rooms.entries()).toEqual([]);
    expect(stateNames(root).some((f) => f.startsWith("bindings.json.corrupt."))).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("a missing file is just a first run, with nothing set aside", () => {
    const root = scratch();
    const rooms = new RoomBindings(join(root, "bindings.json"));
    expect(rooms.entries()).toEqual([]);
    expect(stateNames(root)).toEqual([]);
  });

  test("a write that cannot land is reported, not swallowed", () => {
    const root = scratch();
    const rooms = new RoomBindings(join(root, "nested", "bindings.json"));
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, "this is a file, so nothing can be created under it");
    expect(() => rooms.bind("!room:example.com", "alice")).toThrow();
  });

  test("writes replace the database row atomically", () => {
    const root = scratch();
    const path = join(root, "bindings.json");
    const rooms = new RoomBindings(path);
    rooms.bind("!a:example.com", "alice");
    rooms.bind("!b:example.com", "bob");
    expect(stateNames(root)).toEqual(["bindings.json"]);
    expect(new RoomBindings(path).entries()).toEqual([
      ["alice", "!a:example.com"],
      ["bob", "!b:example.com"],
    ]);
  });
});

function stateNames(data: string): string[] {
  return withStorage(data, (db) => (db.query("SELECT path FROM state_files ORDER BY path").all() as { path: string }[]).map((row) => row.path));
}
