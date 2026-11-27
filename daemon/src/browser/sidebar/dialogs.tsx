import { useState } from "react";
import { Dialog } from "../ui/controls.tsx";
import { toasts } from "../ui/toast.tsx";
import { navigate } from "../app/route.ts";
import { workspace } from "../app/state.ts";
import { PinsField, threadPinList } from "../chat/thread_prompt.tsx";
import { namedThread } from "./thread_names.ts";

export function WhenLongField({ compaction, setCompaction }: { compaction: boolean; setCompaction: (compaction: boolean) => void }) {
  return <label className="field"><span>Older turns are archived</span><select className="select" value={compaction ? "compact" : "trim"} onChange={(event) => setCompaction(event.target.value === "compact")}><option value="trim">Only when the context fills up</option><option value="compact">At the compaction limits</option></select></label>;
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

export function NewThreadDialog({ character, taken, close }: { character: string; taken: readonly string[]; close: () => void }) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [pins, setPins] = useState("");
  const [model, setModel] = useState("");
  const [compaction, setCompaction] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const { id, label } = namedThread(name, taken);
      const pinned = threadPinList(pins);
      await workspace.actions.run("create_thread", { name: id, ...(label === undefined ? {} : { label }), ...(purpose.trim() === "" ? {} : { purpose: purpose.trim() }), ...(pinned.length === 0 ? {} : { pins: pinned }), ...(model.trim() === "" ? {} : { model: model.trim() }), ...(compaction ? { compaction: true } : {}) });
      await workspace.openThread(id);
      navigate({ view: "chat" });
      close();
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return <Dialog title={`New thread with ${character}`} close={close}>
    <form className="form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="field"><span>Name</span><input className="input" data-autofocus placeholder="e.g. Lighthouse trip" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field"><span>Purpose <span className="muted">(optional)</span></span><textarea className="input textarea" rows={2} placeholder={`What this thread is for; ${character} sees it here`} value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label>
      <details className="disclosure"><summary>More options</summary>
        <div className="form">
          <label className="field"><span>Model <span className="muted">(optional)</span></span><input className="input mono" placeholder={`${character}’s default`} value={model} onChange={(event) => setModel(event.target.value)} /></label>
          <PinsField value={pins} change={setPins} note="optional, one per line" />
          <WhenLongField compaction={compaction} setCompaction={setCompaction} />
        </div>
      </details>
      {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button" onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={busy || name.trim() === ""}>{busy ? "Creating…" : "Create"}</button></div>
    </form>
  </Dialog>;
}
