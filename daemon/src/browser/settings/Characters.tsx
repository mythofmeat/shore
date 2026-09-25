import { useState } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { Avatar } from "../ui/avatar.tsx";
import { Dialog, Spinner } from "../ui/controls.tsx";
import { navigate } from "../app/route.ts";
import { workspace } from "../app/state.ts";
import { NewCharacterDialog } from "../sidebar/dialogs.tsx";
import { SettingsSection } from "./layout.tsx";
import { useAction, useOperation } from "./shared.tsx";

function DeleteCharacterDialog({ name, close }: { name: string; close: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [archive, setArchive] = useState("");
  const { busy, run } = useAction();
  return <Dialog title={`Delete ${name}?`} close={close}>
    <form className="form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
      const result = await workspace.actions.run("delete_character", { character: name, confirm, ...(archive.trim() === "" ? {} : { archive: archive.trim() }) });
      await workspace.refreshNavigation();
      close();
      return result.archive === null ? `Deleted ${name}` : `Deleted ${name}; archive saved to ${result.archive}`;
    }); }}>
      <p className="form-text">This removes {name}’s definition, conversations and memory from the daemon. It can’t be undone unless you save an archive first.</p>
      <label className="field"><span>Save an archive first <span className="muted">(optional path on the daemon’s machine)</span></span><input className="input mono" value={archive} placeholder="e.g. ~/backups/nova.shore" onChange={(event) => setArchive(event.target.value)} /></label>
      <label className="field"><span>Type <strong>{name}</strong> to confirm</span><input className="input" autoComplete="off" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
      <div className="form-actions"><button type="button" className="button" onClick={close}>Cancel</button><button type="submit" className="button danger" disabled={busy || confirm !== name}>{busy ? "Deleting…" : "Delete character"}</button></div>
    </form>
  </Dialog>;
}

function CharacterDetails({ state, name }: { state: WorkspaceSnapshot; name: string }) {
  const info = useOperation(state, "character_info", { name }, [name]);
  const [deleting, setDeleting] = useState(false);
  const details = info.data;
  return <div className="rows padded">
    {info.error === "" ? null : <p className="form-error" role="alert">{info.error}</p>}
    {details === undefined ? info.error === "" ? <Spinner label="Loading character" /> : null : <>
      <dl className="kv">
        <div className="kv-row"><dt>Definition</dt><dd>{details.has_definition ? "Set" : "Not written yet"}</dd></div>
        <div className="kv-row"><dt>Configuration</dt><dd>{details.has_config_override ? "Has its own overrides" : "Uses the shared configuration"}</dd></div>
        <div className="kv-row"><dt>Workspace</dt><dd className="mono">{details.workspace_dir}</dd></div>
        <div className="kv-row"><dt>Config folder</dt><dd className="mono">{details.config_dir}</dd></div>
        <div className="kv-row"><dt>Data folder</dt><dd className="mono">{details.has_data ? details.data_dir : "No data yet"}</dd></div>
        {details.bootstrap_files.length === 0 ? null : <div className="kv-row"><dt>Bootstrap files</dt><dd className="mono">{details.bootstrap_files.join(", ")}</dd></div>}
        {details.pending_deferred_edits.length === 0 ? null : <div className="kv-row"><dt>Pending edits</dt><dd className="mono">{details.pending_deferred_edits.join(", ")}</dd></div>}
      </dl>
      {details.definition_preview === null ? null : <><div className="tool-label">Definition preview</div><pre className="readout">{details.definition_preview}</pre></>}
      <div className="actions-row">
        {state.character === name ? null : <button type="button" className="button" onClick={() => { void workspace.actions.run("switch_character", { name }).then(() => navigate({ view: "chat" })); }}>Open conversations</button>}
        <button type="button" className="button danger-outline" onClick={() => setDeleting(true)}>Delete…</button>
      </div>
    </>}
    {deleting ? <DeleteCharacterDialog name={name} close={() => setDeleting(false)} /> : null}
  </div>;
}

export function CharactersPage({ state }: { state: WorkspaceSnapshot }) {
  const [selected, setSelected] = useState(state.character ?? state.characters[0]?.name ?? null);
  const [creating, setCreating] = useState(false);
  const current = state.characters.some((item) => item.name === selected) ? selected : state.characters[0]?.name ?? null;
  return <>
    <p className="settings-description">Characters on this daemon. A character’s prompt and memory live in its workspace folder.</p>
    <SettingsSection title="All characters" actions={<button type="button" className="button" onClick={() => setCreating(true)}>New character</button>}>
      <div className="character-grid" role="listbox" aria-label="Characters">
        {state.characters.map((character) => <button key={character.name} type="button" role="option" aria-selected={character.name === current} className={`character-card ${character.name === current ? "on" : ""}`} onClick={() => setSelected(character.name)}>
          <Avatar name={character.name} avatar={character.avatar} size={40} /><span>{character.name}</span>{character.name === state.character ? <span className="tag">active</span> : null}
        </button>)}
      </div>
      {state.characters.length === 0 ? <p className="settings-empty">No characters yet.</p> : null}
    </SettingsSection>
    {current === null ? null : <SettingsSection title={current}><CharacterDetails key={current} state={state} name={current} /></SettingsSection>}
    {creating ? <NewCharacterDialog close={() => setCreating(false)} /> : null}
  </>;
}
