import { useCallback, useEffect, useMemo, useState } from "react";
import type { BackgroundModelTarget } from "../../protocol/BackgroundModelTarget.ts";
import type { ModelListing } from "../../protocol/ModelListing.ts";
import type { ModelSummary } from "../../protocol/ModelSummary.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Dialog, IconButton, Spinner } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { toasts } from "../ui/toast.tsx";
import { errorText, workspace } from "../app/state.ts";

export type ModelTarget = { kind: "thread" } | { kind: "character" } | { kind: "background"; task: BackgroundModelTarget } | { kind: "subagent"; name: string };

export function useModelListing(state: WorkspaceSnapshot, includeHidden = false, favoritesOnly = false): { listing: ModelListing | undefined; refresh: () => void; error: string } {
  const [listing, setListing] = useState<ModelListing>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (state.status !== "ready" || state.character === null) return;
    let alive = true;
    workspace.actions.run("list_models", { include_hidden: includeHidden, ...(favoritesOnly ? { favorites_only: true } : {}) })
      .then((result) => { if (alive) { setListing(result); setError(""); } })
      .catch((failure: unknown) => { if (alive) setError(errorText(failure)); });
    return () => { alive = false; };
  }, [state.status, state.character, state.thread, includeHidden, favoritesOnly, version]);
  return { listing, refresh, error };
}

export function shortModel(name: string | null | undefined): string {
  if (name === null || name === undefined || name === "") return "No model";
  const index = name.indexOf(":");
  return index < 0 ? name : name.slice(index + 1);
}

export function flattenModels(listing: ModelListing | undefined): ModelSummary[] {
  if (listing === undefined) return [];
  return Object.values(listing.models).flat().sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.qualified_name.localeCompare(b.qualified_name));
}

export function targetLabel(target: ModelTarget, character: string | null): string {
  switch (target.kind) {
    case "thread": return "This conversation";
    case "character": return `${character ?? "Character"}’s default`;
    case "background": return target.task === "all" ? "All background tasks" : `${target.task[0]?.toUpperCase() ?? ""}${target.task.slice(1)}`;
    case "subagent": return `Subagent ${target.name}`;
  }
}

async function applyModel(state: WorkspaceSnapshot, target: ModelTarget, model: string | null, includeHidden: boolean): Promise<void> {
  switch (target.kind) {
    case "thread": await workspace.actions.run("thread_model", { name: state.thread ?? "", model }); break;
    case "character":
      if (model === null) await workspace.actions.run("reset_model", {});
      else await workspace.actions.run("switch_model", { name: model, include_hidden: includeHidden });
      break;
    case "background":
      if (model === null) await workspace.actions.run("reset_model", { background_task: target.task });
      else await workspace.actions.run("switch_model", { name: model, background_task: target.task, include_hidden: includeHidden });
      break;
    case "subagent":
      if (model === null) await workspace.actions.run("reset_model", { subagent: target.name });
      else await workspace.actions.run("switch_model", { name: model, subagent: target.name, include_hidden: includeHidden });
      break;
  }
}

export function ModelPicker({ state, close, target: initial = { kind: "thread" }, changed, scopes = true, current }: {
  state: WorkspaceSnapshot; close: () => void; target?: ModelTarget; changed: () => void; scopes?: boolean; current?: string | null;
}) {
  const [hidden, setHidden] = useState(false);
  const [favorites, setFavorites] = useState(false);
  const { listing, refresh, error } = useModelListing(state, hidden, favorites);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<ModelTarget>(initial);
  const [busy, setBusy] = useState(false);
  const thread = state.threads.find((item) => item.id === state.thread);
  const needle = query.trim().toLowerCase();
  const models = useMemo(() => flattenModels(listing).filter((model) => model.qualified_name.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle)), [listing, needle]);
  const active = current !== undefined ? current : listing?.active ?? null;
  const choose = async (model: string | null) => {
    setBusy(true);
    try {
      await applyModel(state, target, model, hidden);
      await workspace.refreshNavigation();
      if (state.thread !== null) await workspace.actions.run("switch_thread", { name: state.thread, resync: true });
      changed();
      toasts.show(model === null ? `${targetLabel(target, state.character)} now uses the default model` : `${targetLabel(target, state.character)} now uses ${shortModel(model)}`);
      close();
    } catch (failure) { toasts.show(errorText(failure), "error"); } finally { setBusy(false); }
  };
  const favorite = async (model: ModelSummary) => {
    try { await workspace.actions.run("favorite_model", { name: model.qualified_name, favorite: !model.favorite }); refresh(); }
    catch (failure) { toasts.show(errorText(failure), "error"); }
  };
  const resettable = target.kind !== "thread" || thread?.chat_model !== undefined;
  return <Dialog title={scopes ? "Choose a model" : `Model for ${targetLabel(target, state.character).toLowerCase()}`} close={close} wide>
    {scopes ? <div className="segmented" role="radiogroup" aria-label="Apply to">
      <button type="button" role="radio" aria-checked={target.kind === "thread"} onClick={() => setTarget({ kind: "thread" })}>This conversation</button>
      <button type="button" role="radio" aria-checked={target.kind === "character"} onClick={() => setTarget({ kind: "character" })}>{state.character ?? "Character"}’s default</button>
    </div> : null}
    <p className="form-text">Currently using <span className="mono">{active ?? "the configured default"}</span>.</p>
    <div className="picker-tools">
      <label className="sidebar-search picker-search"><Icon name="search" size={16} /><input type="search" autoFocus aria-label="Search models" placeholder="Search models" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={favorites} onChange={(event) => setFavorites(event.target.checked)} />Favorites</label>
      <label className="check"><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />Show hidden</label>
    </div>
    {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
    <div className="picker-list" role="listbox" aria-label="Models">
      {resettable ? <button type="button" className="picker-item" disabled={busy} onClick={() => void choose(null)}><span className="picker-name">{target.kind === "thread" ? `Use ${state.character ?? "the character"}’s default` : "Use the configured default"}</span></button> : null}
      {listing === undefined ? <div className="picker-empty"><Spinner label="Loading models" /></div> : models.length === 0 ? <p className="picker-empty">{favorites ? "No favorite models yet. Star a model to add it." : "No models match."}</p> : models.map((model) =>
        <div key={model.qualified_name} className={`picker-row ${model.qualified_name === active ? "on" : ""}`}>
          <button type="button" role="option" aria-selected={model.qualified_name === active} className="picker-item" disabled={busy} onClick={() => void choose(model.qualified_name)}>
            <span className="picker-name mono">{model.qualified_name}</span>
            {model.name !== model.model_id ? <span className="picker-detail">{model.name}</span> : null}
            {model.hidden ? <span className="tag muted-tag">hidden</span> : null}
            {model.qualified_name === active ? <Icon name="check" size={16} className="picker-check" /> : null}
          </button>
          <IconButton icon="star" label={model.favorite ? `Remove ${model.qualified_name} from favorites` : `Add ${model.qualified_name} to favorites`} className={model.favorite ? "favorite" : ""} onClick={() => void favorite(model)} />
        </div>)}
    </div>
  </Dialog>;
}
