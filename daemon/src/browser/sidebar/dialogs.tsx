import { useState } from "react";
import { Dialog } from "../ui/controls.tsx";
import { toasts } from "../ui/toast.tsx";
import { navigate } from "../app/route.ts";
import { workspace } from "../app/state.ts";

export function threadFileList(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

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
      <label className="field"><span>Name</span><input className="input" data-autofocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <p className="form-hint">You can set up the character’s prompt and model afterwards in Settings.</p>
      {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button" onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={busy || name.trim() === ""}>{busy ? "Creating…" : "Create"}</button></div>
    </form>
  </Dialog>;
}

export function NewThreadDialog({ character, close }: { character: string; close: () => void }) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [purpose, setPurpose] = useState("");
  const [files, setFiles] = useState("");
  const [model, setModel] = useState("");
  const [compaction, setCompaction] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const id = name.trim();
      const paths = threadFileList(files);
      await workspace.actions.run("create_thread", { name: id, ...(label.trim() === "" ? {} : { label: label.trim() }), ...(purpose.trim() === "" ? {} : { purpose: purpose.trim() }), ...(paths.length === 0 ? {} : { files: paths }), ...(model.trim() === "" ? {} : { model: model.trim() }), ...(compaction ? { compaction: true } : {}) });
      await workspace.actions.run("switch_thread", { name: id, resync: true });
      await workspace.refreshNavigation();
      navigate({ view: "chat" });
      close();
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return <Dialog title={`New conversation with ${character}`} close={close}>
    <form className="form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="field"><span>Name</span><input className="input" data-autofocus placeholder="e.g. lighthouse" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field"><span>Label <span className="muted">(optional)</span></span><input className="input" placeholder="Shown in the sidebar" value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <label className="field"><span>Purpose <span className="muted">(optional)</span></span><textarea className="input textarea" rows={2} placeholder={`What this conversation is for; ${character} sees it here`} value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label>
      <details className="disclosure"><summary>More options</summary>
        <div className="form">
          <label className="field"><span>Model <span className="muted">(optional)</span></span><input className="input mono" placeholder={`${character}’s default`} value={model} onChange={(event) => setModel(event.target.value)} /></label>
          <label className="field"><span>Files in the prompt <span className="muted">(optional, one per line)</span></span><textarea className="input textarea mono" rows={3} placeholder={"stories/lighthouse.md\n[[lighthouse/]]"} value={files} onChange={(event) => setFiles(event.target.value)} /></label>
          <label className="field"><span>When it gets long</span><select className="select" value={compaction ? "compact" : "trim"} onChange={(event) => setCompaction(event.target.value === "compact")}><option value="trim">Trim its oldest turns into the archive</option><option value="compact">Compact it into memory, as the home thread does</option></select></label>
        </div>
      </details>
      {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button" onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={busy || name.trim() === ""}>{busy ? "Creating…" : "Create"}</button></div>
    </form>
  </Dialog>;
}
