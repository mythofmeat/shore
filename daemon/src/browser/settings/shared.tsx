import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { OperationInput, OperationName, OperationResult } from "../../operations/types.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Spinner } from "../ui/controls.tsx";
import { toasts } from "../ui/toast.tsx";
import { errorText, workspace } from "../app/state.ts";

export interface OperationState<N extends OperationName> { data: OperationResult<N> | undefined; error: string; loading: boolean; refresh: () => void }

export function useOperation<N extends OperationName>(state: WorkspaceSnapshot, name: N, input: OperationInput<N>, deps: readonly unknown[], enabled = true): OperationState<N> {
  const [data, setData] = useState<OperationResult<N>>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!enabled || state.status !== "ready") return;
    let alive = true;
    setLoading(true);
    workspace.actions.run(name, JSON.parse(key) as OperationInput<N>, { remember: false })
      .then((result) => { if (alive) { setData(result); setError(""); } })
      .catch((failure: unknown) => { if (alive) setError(errorText(failure)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [state.status, state.character, name, key, enabled, version, ...deps]);
  return { data, error, loading, refresh };
}

export function useAction(): { busy: boolean; run: (work: () => Promise<string | undefined>) => Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (work: () => Promise<string | undefined>) => {
    setBusy(true);
    try { const message = await work(); if (message !== undefined) toasts.show(message); return true; }
    catch (failure) { toasts.show(errorText(failure), "error"); return false; }
    finally { setBusy(false); }
  }, []);
  return { busy, run };
}

export function NeedsCharacter() {
  return <p className="settings-description">Choose a character in the sidebar first; these settings belong to a character.</p>;
}

export function Loading({ error, children, ready }: { error: string; ready: boolean; children: ReactNode }) {
  if (error !== "") return <p className="form-error" role="alert">{error}</p>;
  if (!ready) return <div className="settings-empty"><Spinner /></div>;
  return <>{children}</>;
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString();
}

export function formatCost(value: number): string {
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 });
}

export function formatTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function downloadText(filename: string, text: string, type = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
