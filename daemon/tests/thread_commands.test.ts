import { describe, expect, test } from "bun:test";

import { CommandError } from "../src/commands/errors.ts";
import {
  archiveThread,
  listThreads,
  newThread,
  switchThread,
  threadHome,
  threadLabel,
  threadModel,
  type ThreadContext,
  type ThreadRegistry,
} from "../src/commands/threads.ts";
import { MAIN_THREAD } from "../src/config/dirs.ts";
import { ThreadError, type ThreadRecord, type ThreadsIndex } from "../src/engine/threads.ts";

const NOW = "2026-09-03T12:00:00.000Z";

function record(id: string, extra: Partial<ThreadRecord> = {}): ThreadRecord {
  return { id, created_at: NOW, compaction: false, ...extra };
}

class FakeRegistry implements ThreadRegistry {
  index: ThreadsIndex;
  readonly calls: string[] = [];

  constructor(threads: ThreadRecord[], home = MAIN_THREAD) {
    this.index = { version: 1, home, threads };
  }

  listThreads(): readonly ThreadRecord[] {
    return this.index.threads;
  }

  homeThread(): string {
    return this.index.home;
  }

  createThread(_c: string, id: string, options = {}): Promise<ThreadsIndex> {
    this.calls.push(`create:${id}:${JSON.stringify(options)}`);
    if (this.index.threads.some((t) => t.id === id)) {
      return Promise.reject(new ThreadError("exists", `thread "${id}" already exists`));
    }
    this.index = { ...this.index, threads: [...this.index.threads, record(id, options)] };
    return Promise.resolve(this.index);
  }

  archiveThread(_c: string, id: string): Promise<ThreadsIndex> {
    this.calls.push(`archive:${id}`);
    if (id === this.index.home) {
      return Promise.reject(new ThreadError("is_home", `thread "${id}" is the heartbeat home`));
    }
    this.index = { ...this.index, threads: this.index.threads.filter((t) => t.id !== id) };
    return Promise.resolve(this.index);
  }

  setHomeThread(_c: string, id: string): Promise<ThreadsIndex> {
    this.calls.push(`home:${id}`);
    if (!this.index.threads.some((t) => t.id === id)) {
      return Promise.reject(new ThreadError("not_found", `no thread "${id}"`));
    }
    this.index = { ...this.index, home: id };
    return Promise.resolve(this.index);
  }

  setThreadLabel(_c: string, id: string, label: string | undefined): Promise<ThreadsIndex> {
    this.calls.push(`label:${id}:${label ?? "<cleared>"}`);
    this.index = {
      ...this.index,
      threads: this.index.threads.map((t) => {
        if (t.id !== id) return t;
        const { label: _drop, ...rest } = t;
        return label === undefined ? rest : { ...rest, label };
      }),
    };
    return Promise.resolve(this.index);
  }

  setThreadModel(_c: string, id: string, model: string | undefined): Promise<ThreadsIndex> {
    this.calls.push(`model:${id}:${model ?? "<cleared>"}`);
    if (!this.index.threads.some((t) => t.id === id)) {
      return Promise.reject(new ThreadError("not_found", `no thread "${id}"`));
    }
    this.index = {
      ...this.index,
      threads: this.index.threads.map((t) => {
        if (t.id !== id) return t;
        const { chat_model: _drop, ...rest } = t;
        return model === undefined ? rest : { ...rest, chat_model: model };
      }),
    };
    return Promise.resolve(this.index);
  }
}

function ctx(registry: FakeRegistry, current = MAIN_THREAD): ThreadContext {
  return { registry, character: "qifei", current };
}

describe("what a listed thread says about itself", () => {
  function counted(
    registry: FakeRegistry,
    turns: ReadonlyMap<string, number>,
    warm?: string,
  ): ThreadContext {
    return {
      ...ctx(registry),
      turns,
      ...(warm === undefined ? {} : { warm }),
    };
  }

  test("each thread carries its own turn count", () => {
    const registry = new FakeRegistry([record(MAIN_THREAD), record("eval")]);
    const out = listThreads(
      counted(registry, new Map([[MAIN_THREAD, 12], ["eval", 1]])),
    );

    expect(out.threads.map((t) => [t.id, t.turns])).toEqual([
      [MAIN_THREAD, 12],
      ["eval", 1],
    ]);
  });

  test("a thread the count did not reach reads as zero, not as unknown", () => {
    const registry = new FakeRegistry([record(MAIN_THREAD), record("brand-new")]);
    const out = listThreads(counted(registry, new Map([[MAIN_THREAD, 3]])));

    expect(out.threads.find((t) => t.id === "brand-new")?.turns).toBe(0);
  });

  test("a daemon that counted nothing omits the field rather than claiming zero", () => {
    const registry = new FakeRegistry([record(MAIN_THREAD)]);
    const out = listThreads(ctx(registry));

    expect(out.threads[0]).not.toHaveProperty("turns");
  });

  test("only the thread holding the cache slot is marked warm", () => {
    const registry = new FakeRegistry([record(MAIN_THREAD), record("eval")]);
    const out = listThreads(counted(registry, new Map(), "eval"));

    expect(out.threads.find((t) => t.id === "eval")?.warm).toBe(true);
    expect(out.threads.find((t) => t.id === MAIN_THREAD)).not.toHaveProperty("warm");
  });

  test("nothing warm marks nothing", () => {
    const registry = new FakeRegistry([record(MAIN_THREAD), record("eval")]);
    const out = listThreads(counted(registry, new Map()));

    expect(out.threads.some((t) => t.warm === true)).toBe(false);
  });

  test("the counts survive a mutation, so a rename still reports turns", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD), record("eval")]);
    const out = await threadLabel(
      counted(registry, new Map([["eval", 4]]), "eval"),
      { name: "eval", label: "SDK eval" },
    );

    const eval_ = out.threads.find((t) => t.id === "eval");
    expect([eval_?.label, eval_?.turns, eval_?.warm]).toEqual(["SDK eval", 4, true]);
  });
});

describe("listing threads", () => {
  test("marks which is home and which the session is looking at", () => {
    const registry = new FakeRegistry([record(MAIN_THREAD), record("scratch")]);
    const out = listThreads(ctx(registry, "scratch"));

    expect(out.character).toBe("qifei");
    expect(out.home).toBe(MAIN_THREAD);
    expect(out.current).toBe("scratch");
    expect(out.threads.map((t) => [t.id, t.home, t.current])).toEqual([
      [MAIN_THREAD, true, false],
      ["scratch", false, true],
    ]);
  });

  test("a session pointed at a thread that is gone reads as being on home", () => {
    const registry = new FakeRegistry([record(MAIN_THREAD)]);
    const out = listThreads(ctx(registry, "archived"));

    expect(out.current).toBe(MAIN_THREAD);
    expect(out.threads.every((t) => !t.current || t.id === MAIN_THREAD)).toBe(true);
  });

  test("home and current can be the same thread", () => {
    const out = listThreads(ctx(new FakeRegistry([record(MAIN_THREAD)])));
    expect(out.threads[0]).toEqual({
      id: MAIN_THREAD,
      created_at: NOW,
      compaction: false,
      home: true,
      current: true,
    });
  });
});

describe("switching threads", () => {
  test("a switch to another thread reports the change", () => {
    const registry = new FakeRegistry([record(MAIN_THREAD), record("scratch")]);
    expect(switchThread(ctx(registry), { name: "scratch" })).toEqual({
      character: "qifei",
      thread: "scratch",
      changed: true,
    });
  });

  test("switching to the thread already in use changes nothing", () => {
    const registry = new FakeRegistry([record(MAIN_THREAD)]);
    expect(switchThread(ctx(registry), { name: MAIN_THREAD })).toEqual({
      character: "qifei",
      thread: MAIN_THREAD,
      changed: false,
    });
  });

  test("an unknown thread is not found, never a silent fallback", () => {
    const registry = new FakeRegistry([record(MAIN_THREAD)]);
    expect(() => switchThread(ctx(registry), { name: "nowhere" })).toThrow(CommandError);
    try {
      switchThread(ctx(registry), { name: "nowhere" });
    } catch (e) {
      expect((e as CommandError).code).toBe("not_found");
    }
  });

  test("a missing name is an invalid request", () => {
    const registry = new FakeRegistry([record(MAIN_THREAD)]);
    expect(() => switchThread(ctx(registry), {})).toThrow("Missing required argument: name");
  });
});

describe("creating a thread", () => {
  test("passes the label and model through and returns the new listing", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD)]);
    const out = await newThread(ctx(registry), {
      name: "eval",
      label: "  Agent SDK eval  ",
      model: "claude-agent:opus5",
    });

    expect(registry.calls).toEqual([
      'create:eval:{"label":"Agent SDK eval","chat_model":"claude-agent:opus5"}',
    ]);
    expect(out.threads.map((t) => t.id)).toEqual([MAIN_THREAD, "eval"]);
  });

  test("compaction stays off unless asked for", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD)]);
    await newThread(ctx(registry), { name: "a" });
    await newThread(ctx(registry), { name: "b", compaction: true });

    expect(registry.calls).toEqual(["create:a:{}", 'create:b:{"compaction":true}']);
  });

  test("an empty label is no label rather than a blank one", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD)]);
    await newThread(ctx(registry), { name: "a", label: "   " });
    expect(registry.calls).toEqual(["create:a:{}"]);
  });

  test("a duplicate reads as an invalid request, not an internal error", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD), record("scratch")]);
    try {
      await newThread(ctx(registry), { name: "scratch" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(CommandError);
      expect((e as CommandError).code).toBe("invalid_request");
    }
  });
});

describe("archiving, home and labels", () => {
  test("archiving drops the thread from the listing", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD), record("scratch")]);
    const out = await archiveThread(ctx(registry), { name: "scratch" });

    expect(out.threads.map((t) => t.id)).toEqual([MAIN_THREAD]);
    expect(out.current).toBe(MAIN_THREAD);
  });

  test("archiving the home thread is refused with the reason, not a stack trace", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD), record("scratch")]);
    try {
      await archiveThread(ctx(registry), { name: MAIN_THREAD });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(CommandError);
      expect((e as CommandError).message).toContain("heartbeat home");
    }
  });

  test("moving home is reflected in the listing straight away", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD), record("scratch")]);
    const out = await threadHome(ctx(registry), { name: "scratch" });

    expect(out.home).toBe("scratch");
    expect(out.threads.find((t) => t.id === "scratch")?.home).toBe(true);
    expect(out.threads.find((t) => t.id === MAIN_THREAD)?.home).toBe(false);
  });

  test("pointing home at nothing is not found", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD)]);
    try {
      await threadHome(ctx(registry), { name: "nowhere" });
      throw new Error("expected a refusal");
    } catch (e) {
      expect((e as CommandError).code).toBe("not_found");
    }
  });

  test("a label with no value clears it", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD, { label: "Old" })]);
    const out = await threadLabel(ctx(registry), { name: MAIN_THREAD });

    expect(registry.calls).toEqual([`label:${MAIN_THREAD}:<cleared>`]);
    expect(out.threads[0]).not.toHaveProperty("label");
  });

  test("a label is trimmed before it is stored", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD)]);
    await threadLabel(ctx(registry), { name: MAIN_THREAD, label: "  Brian  " });
    expect(registry.calls).toEqual([`label:${MAIN_THREAD}:Brian`]);
  });
});

describe("pinning a thread to a model", () => {
  test("the pin lands on the thread and comes back in the listing", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD), record("eval")]);
    const out = await threadModel(ctx(registry), { name: "eval", model: "claude-agent:opus5" });

    expect(registry.calls).toEqual(["model:eval:claude-agent:opus5"]);
    expect(out.threads.find((t) => t.id === "eval")?.chat_model).toBe("claude-agent:opus5");
  });

  test("no model clears the pin so the thread inherits the character's", async () => {
    const registry = new FakeRegistry([record("eval", { chat_model: "anthropic:opus" })]);
    const out = await threadModel(ctx(registry, "eval"), { name: "eval" });

    expect(registry.calls).toEqual(["model:eval:<cleared>"]);
    expect(out.threads[0]).not.toHaveProperty("chat_model");
  });

  test("the model name is trimmed before it is stored", async () => {
    const registry = new FakeRegistry([record("eval")]);
    await threadModel(ctx(registry, "eval"), { name: "eval", model: "  anthropic:opus  " });
    expect(registry.calls).toEqual(["model:eval:anthropic:opus"]);
  });

  test("pinning an unknown thread is not found", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD)]);
    try {
      await threadModel(ctx(registry), { name: "ghost", model: "anthropic:opus" });
      throw new Error("expected a rejection");
    } catch (e) {
      expect((e as CommandError).code).toBe("not_found");
    }
  });

  test("a non-string model is an invalid request", async () => {
    const registry = new FakeRegistry([record(MAIN_THREAD)]);
    try {
      await threadModel(ctx(registry), { name: MAIN_THREAD, model: 7 });
      throw new Error("expected a rejection");
    } catch (e) {
      expect((e as CommandError).code).toBe("invalid_request");
    }
  });
});
