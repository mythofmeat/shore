import { useState } from "react";
import { Dialog } from "../ui/controls.tsx";
import { toasts } from "../ui/toast.tsx";
import { navigate } from "../app/route.ts";
import { workspace } from "../app/state.ts";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function NewCharacterDialog({ close }: { close: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try {
      await workspace.actions.run("create_character", { name: name.trim() });
      await workspace.refreshNavigation();
      await workspace.actions.run("switch_character", { name: name.trim() });
      navigate({ view: "chat" });
      toasts.show(`Created ${name.trim()}`);
      close();
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return <Dialog title="New character" close={close}>
    <form className="form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="field"><span>Name</span><input className="input" autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <p className="form-hint">You can set up the character’s prompt and model afterwards in Settings.</p>
      {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button" onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={busy || name.trim() === ""}>{busy ? "Creating…" : "Create"}</button></div>
    </form>
  </Dialog>;
}

export function NewThreadDialog({ character, close }: { character: string; close: () => void }) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [compaction, setCompaction] = useState<"default" | "on" | "off">("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const id = name.trim();
      await workspace.actions.run("create_thread", { name: id, ...(label.trim() === "" ? {} : { label: label.trim() }), ...(model.trim() === "" ? {} : { model: model.trim() }), ...(compaction === "default" ? {} : { compaction: compaction === "on" }) });
      await workspace.actions.run("switch_thread", { name: id, resync: true });
      await workspace.refreshNavigation();
      navigate({ view: "chat" });
      close();
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return <Dialog title={`New conversation with ${character}`} close={close}>
    <form className="form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="field"><span>Name</span><input className="input" autoFocus placeholder="e.g. lighthouse" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field"><span>Label <span className="muted">(optional)</span></span><input className="input" placeholder="Shown in the sidebar" value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <details className="disclosure"><summary>More options</summary>
        <div className="form">
          <label className="field"><span>Model <span className="muted">(optional)</span></span><input className="input mono" placeholder={`${character}’s default`} value={model} onChange={(event) => setModel(event.target.value)} /></label>
          <label className="field"><span>Automatic compaction</span><select className="select" value={compaction} onChange={(event) => setCompaction(event.target.value as "default" | "on" | "off")}><option value="default">Use the configured default</option><option value="on">On</option><option value="off">Off</option></select></label>
        </div>
      </details>
      {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button" onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={busy || name.trim() === ""}>{busy ? "Creating…" : "Create"}</button></div>
    </form>
  </Dialog>;
}
