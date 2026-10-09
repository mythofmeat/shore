import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { isCompiledDaemon } from "../llm/providers/claude_code.ts";
import { shoreLog } from "../log.ts";
import type { HelperReply, HelperRequest } from "./workspace_helper_server.ts";
import { WORKSPACE_HELPER_FLAG } from "./workspace_helper_flag.ts";
import { decodeError } from "./workspace_ops.ts";

const CANCEL_GRACE_MS = 5_000;
const STDERR_LINES = 20;

export interface HelperLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export function helperCommand(compiled: boolean = isCompiledDaemon()): string[] {
  return compiled
    ? [process.execPath, WORKSPACE_HELPER_FLAG]
    : [process.execPath, join(import.meta.dir, "../daemon/main.ts"), WORKSPACE_HELPER_FLAG];
}

export class WorkspaceHelper {
  readonly #label: string;
  readonly #launch: () => Promise<HelperLaunch>;
  readonly #pending = new Map<number, Pending>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #starting: Promise<ChildProcessWithoutNullStreams> | undefined;
  #stderr: string[] = [];
  #next = 1;

  constructor(label: string, launch: () => Promise<HelperLaunch>) {
    this.#label = label;
    this.#launch = launch;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  async call(op: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const child = await this.#ensure();
    signal?.throwIfAborted();
    const id = this.#next++;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (): void => {
      this.#write(child, { cancel: id });
      killer = setTimeout(() => {
        shoreLog.warn(`shore: the workspace helper for ${this.#label} did not stop a cancelled ${op}; restarting it`);
        this.#kill(child);
      }, CANCEL_GRACE_MS);
      killer.unref?.();
    };
    try {
      return await new Promise<unknown>((resolve, reject) => {
        if (this.#child !== child || !child.stdin.writable) {
          reject(new Error(`the workspace helper for ${this.#label} stopped before it could ${op}`));
          return;
        }
        this.#pending.set(id, { resolve, reject });
        signal?.addEventListener("abort", cancel, { once: true });
        this.#write(child, { id, op, args });
      });
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      clearTimeout(killer);
      this.#pending.delete(id);
    }
  }

  close(): void {
    const child = this.#child;
    if (child === undefined) return;
    child.stdin.end();
    const killer = setTimeout(() => this.#kill(child), CANCEL_GRACE_MS);
    killer.unref?.();
  }

  async #ensure(): Promise<ChildProcessWithoutNullStreams> {
    if (this.#child !== undefined) return this.#child;
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return await this.#starting;
  }

  async #start(): Promise<ChildProcessWithoutNullStreams> {
    const { command, args, env } = await this.#launch();
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env, cwd: "/", detached: process.platform !== "win32" });
    this.#child = child;
    this.#stderr = [];
    child.unref();
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => this.#reply(line));
    createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
      this.#stderr = [...this.#stderr, line].slice(-STDERR_LINES);
      shoreLog.warn(`shore: workspace helper for ${this.#label}: ${line}`);
    });
    const stopped = (reason: string): void => {
      if (this.#child !== child) return;
      this.#child = undefined;
      const detail = this.#stderr.length > 0 ? `: ${this.#stderr.join("\n")}` : "";
      const error = new Error(`the workspace helper for ${this.#label} stopped (${reason})${detail}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
    child.on("error", (error) => stopped(error.message));
    child.on("exit", (code, signal) => stopped(signal ?? `exit code ${String(code)}`));
    return child;
  }

  #reply(line: string): void {
    if (line.trim() === "") return;
    let reply: HelperReply;
    try {
      reply = JSON.parse(line) as HelperReply;
    } catch {
      shoreLog.warn(`shore: workspace helper for ${this.#label} wrote a line that is not a reply: ${line.slice(0, 200)}`);
      return;
    }
    const pending = this.#pending.get(reply.id);
    if (pending === undefined) return;
    if ("error" in reply) pending.reject(decodeError(reply.error));
    else pending.resolve(reply.result);
  }

  #write(child: ChildProcessWithoutNullStreams, request: HelperRequest): void {
    if (!child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  #kill(child: ChildProcessWithoutNullStreams): void {
    try {
      if (child.pid !== undefined) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        shoreLog.warn(`shore: could not stop the workspace helper for ${this.#label}: ${String(error)}`);
      }
    }
  }
}
