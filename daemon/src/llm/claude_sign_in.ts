import type { query, Query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";

import { silentUntil } from "./claude_plan_limits.ts";
import { claudeCodeLaunchFailure, claudeCodeOptions } from "./providers/claude_code.ts";

const START_TIMEOUT_MS = 30_000;

export interface SignedIn {
  email?: string;
  plan?: string;
}

export interface SignInFlow {
  url: string;
  state: string;
  submit(code: string, state: string): Promise<SignedIn>;
  close(): void;
}

export type ClaudeSignInQuery = (params: Parameters<typeof query>[0]) => Pick<Query, "close">;

interface SignInControls {
  claudeAuthenticate(loginWithClaudeAi: boolean): Promise<{ manualUrl?: unknown }>;
  claudeOAuthCallback(authorizationCode: string, state: string): Promise<{ account?: { email?: unknown; subscriptionType?: unknown } } | undefined>;
}

function signInControls(session: object): SignInControls {
  const controls = session as Partial<SignInControls>;
  if (typeof controls.claudeAuthenticate !== "function" || typeof controls.claudeOAuthCallback !== "function") {
    throw new Error("this version of the Claude Agent SDK can't relay a sign-in: its query has no claudeAuthenticate or claudeOAuthCallback");
  }
  return controls as SignInControls;
}

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(what)), ms);
    timer.unref();
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function startClaudeSignIn(runQuery: ClaudeSignInQuery, env: Record<string, string>): Promise<SignInFlow> {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const abortController = new AbortController();
  let session: ReturnType<ClaudeSignInQuery> | undefined;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    release();
    session?.close();
    abortController.abort();
  };
  try {
    session = runQuery({
      prompt: silentUntil(held),
      options: {
        cwd: tmpdir(), env, ...claudeCodeOptions(), abortController,
        settingSources: [], strictMcpConfig: true, tools: [], skills: [],
        persistSession: false,
      },
    });
    const controls = signInControls(session);
    const urls = await within(controls.claudeAuthenticate(true), START_TIMEOUT_MS, "Claude Code didn't start the sign-in within 30 seconds");
    const url = text(urls.manualUrl);
    if (url === undefined) throw new Error("Claude Code started a sign-in but gave no address to open");
    const state = new URL(url).searchParams.get("state") ?? "";
    return {
      url,
      state,
      submit: async (code, codeState) => {
        try {
          const reply = await controls.claudeOAuthCallback(code, codeState);
          const email = text(reply?.account?.email);
          const plan = text(reply?.account?.subscriptionType);
          return { ...(email === undefined ? {} : { email }), ...(plan === undefined ? {} : { plan }) };
        } finally {
          close();
        }
      },
      close,
    };
  } catch (e) {
    close();
    throw claudeCodeLaunchFailure(e) ?? e;
  }
}
