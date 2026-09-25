import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelListing } from "../../protocol/ModelListing.ts";
import type { ModelSummary } from "../../protocol/ModelSummary.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Dialog, IconButton, Spinner } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { toasts } from "../ui/toast.tsx";
import { errorText, workspace } from "../app/state.ts";

export function useModelListing(state: WorkspaceSnapshot, includeHidden = false): { listing: ModelListing | undefined; refresh: () => void; error: string } {
  const [listing, setListing] = useState<ModelListing>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (state.status !== "ready" || state.character === null) return;
    let alive = true;
    workspace.actions.run("list_models", { include_hidden: includeHidden }, { remember: false })
      .then((result) => { if (alive) { setListing(result); setError(""); } })
      .catch((failure: unknown) => { if (alive) setError(errorText(failure)); });
    return () => { alive = false; };
  }, [state.status, state.character, state.thread, includeHidden, version]);
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

export function ModelPicker({ state, close, initialScope = "thread", changed }: { state: WorkspaceSnapshot; close: () => void; initialScope?: "thread" | "character"; changed: () => void }) {
  const [hidden, setHidden] = useState(false);
  const { listing, refresh, error } = useModelListing(state, hidden);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState(initialScope);
  const [busy, setBusy] = useState(false);
  const thread = state.threads.find((item) => item.id === state.thread);
  const models = useMemo(() => flattenModels(listing).filter((model) => model.qualified_name.toLowerCase().includes(query.trim().toLowerCase()) || model.name.toLowerCase().includes(query.trim().toLowerCase())), [listing, query]);
  const choose = async (model: string | null) => {
    if (state.thread === null && scope === "thread") return;
    setBusy(true);
    try {
      if (scope === "thread") await workspace.actions.run("thread_model", { name: state.thread ?? "", model });
      else if (model !== null) await workspace.actions.run("switch_model", { name: model, include_hidden: hidden });
      await workspace.refreshNavigation();
      if (state.thread !== null) await workspace.actions.run("switch_thread", { name: state.thread, resync: true });
      changed();
      toasts.show(model === null ? "This conversation now uses the character default" : `Now using ${shortModel(model)}`);
      close();
    } catch (failure) { toasts.show(errorText(failure), "error"); } finally { setBusy(false); }
  };
  const favorite = async (model: ModelSummary) => {
    try { await workspace.actions.run("favorite_model", { name: model.qualified_name, favorite: !model.favorite }); refresh(); }
    catch (failure) { toasts.show(errorText(failure), "error"); }
  };
  const active = listing?.active ?? null;
  return <Dialog title="Choose a model" close={close} wide>
    <div className="segmented" role="radiogroup" aria-label="Apply to">
      <button type="button" role="radio" aria-checked={scope === "thread"} onClick={() => setScope("thread")}>This conversation</button>
      <button type="button" role="radio" aria-checked={scope === "character"} onClick={() => setScope("character")}>{state.character ?? "Character"}’s default</button>
    </div>
    <p className="form-text">Currently using <span className="mono">{active ?? "the configured default"}</span>{thread?.chat_model === undefined ? "" : " for this conversation"}.</p>
    <div className="picker-tools">
      <label className="sidebar-search picker-search"><Icon name="search" size={16} /><input type="search" autoFocus aria-label="Search models" placeholder="Search models" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />Show hidden</label>
    </div>
    {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
    <div className="picker-list" role="listbox" aria-label="Models">
      {scope === "thread" && thread?.chat_model !== undefined ? <button type="button" className="picker-item" disabled={busy} onClick={() => void choose(null)}><span className="picker-name">Use {state.character}’s default</span></button> : null}
      {listing === undefined ? <div className="picker-empty"><Spinner label="Loading models" /></div> : models.length === 0 ? <p className="picker-empty">No models match.</p> : models.map((model) =>
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
