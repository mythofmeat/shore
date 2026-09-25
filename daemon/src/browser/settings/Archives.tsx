import { useEffect, useRef, useState } from "react";
import type { WebArchiveInfo } from "../../protocol/WebArchiveInfo.ts";
import type { WebArchiveList } from "../../protocol/WebArchiveList.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { validWebArchiveInfo, validWebArchiveList } from "../validators.generated.js";
import { Dialog } from "../ui/controls.tsx";
import { toasts } from "../ui/toast.tsx";
import { errorText, workspace } from "../app/state.ts";
import { SettingsSection } from "./layout.tsx";
import { formatTime, useAction } from "./shared.tsx";
import { archiveStatus } from "./format.ts";

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;

async function transfer(path: string, body?: BodyInit, headers?: HeadersInit, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`/api/archives${path}`, { method: "POST", credentials: "same-origin", ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }), signal: signal ?? AbortSignal.timeout(60_000) });
  if (!response.ok) {
    const problem: unknown = await response.json().catch(() => null);
    throw new Error(problem !== null && typeof problem === "object" && "message" in problem && typeof problem.message === "string" ? problem.message : "The archive transfer failed");
  }
  return response;
}

async function archiveInfo(response: Response): Promise<WebArchiveInfo> {
  const value: unknown = await response.json();
  if (!validWebArchiveInfo(value)) throw new Error("The daemon sent an unexpected archive response. Reload the page.");
  return value;
}


function PathTools({ state }: { state: WorkspaceSnapshot }) {
  const [character, setCharacter] = useState(state.character ?? "");
  const [output, setOutput] = useState("");
  const [archive, setArchive] = useState("");
  const { busy, run } = useAction();
  return <div className="rows padded">
    <form className="inline-form wrap" onSubmit={(event) => { event.preventDefault(); void run(async () => {
      const result = await workspace.actions.run("export_character", { character, output: output.trim() });
      return `Exported ${character} to ${result.archive}`;
    }); }}>
      <select className="select" aria-label="Character to export to a path" value={character} onChange={(event) => setCharacter(event.target.value)}>{state.characters.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select>
      <input className="input mono" aria-label="Export path" placeholder="/path/to/folder or file.tar.gz" value={output} onChange={(event) => setOutput(event.target.value)} />
      <button type="submit" className="button" disabled={busy || character === "" || output.trim() === ""}>Export to path</button>
    </form>
    <form className="inline-form wrap" onSubmit={(event) => { event.preventDefault(); void run(async () => {
      const result = await workspace.actions.run("import_character", { archive: archive.trim() });
      await workspace.refreshNavigation();
      return `Imported ${result.character}`;
    }); }}>
      <input className="input mono" aria-label="Archive path to import" placeholder="/path/to/character.tar.gz" value={archive} onChange={(event) => setArchive(event.target.value)} />
      <button type="submit" className="button" disabled={busy || archive.trim() === ""}>Import from path</button>
    </form>
  </div>;
}

export function ArchivesPage({ state }: { state: WorkspaceSnapshot }) {
  const [listing, setListing] = useState<WebArchiveList>();
  const [selected, setSelected] = useState(state.character ?? "");
  const [confirm, setConfirm] = useState<WebArchiveInfo>();
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const upload = useRef<AbortController | null>(null);
  const { busy, run } = useAction();
  const ready = state.status === "ready";
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value: unknown = await (await transfer("/list")).json();
        if (!validWebArchiveList(value)) throw new Error("The daemon sent an unexpected archive list. Reload the page.");
        if (alive) { setListing(value); setError(""); }
      } catch (failure) { if (alive) setError(errorText(failure)); }
      finally { if (alive) timer = setTimeout(() => { void poll(); }, 1500); }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [ready, version]);
  const refresh = () => setVersion((value) => value + 1);
  const receive = (file: File) => void run(async () => {
    if (listing !== undefined && file.size > listing.max_upload_bytes) throw new Error(`Choose an archive no larger than ${mib(listing.max_upload_bytes)}`);
    const controller = new AbortController(); upload.current = controller;
    try { await archiveInfo(await transfer("", file, { "content-type": "application/octet-stream", "x-shore-filename": encodeURIComponent(file.name) }, controller.signal)); }
    finally { upload.current = null; refresh(); }
    return "Uploaded. Import it from the list below.";
  });
  const download = (archive: WebArchiveInfo) => void run(async () => {
    const response = await transfer(`/${archive.id}/download`);
    const blob = await response.blob();
    if (blob.size !== archive.bytes) throw new Error("The download was incomplete. Prepare the export again.");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = archive.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    refresh();
    return `Downloaded ${archive.filename}`;
  });
  return <>
    <p className="settings-description">Move a character between Shore installations. An archive holds the character’s configuration, workspace, conversations, media, usage and diagnostics.</p>
    <SettingsSection title="From this computer" description={listing === undefined ? undefined : `Up to ${mib(listing.max_upload_bytes)} per archive.`}>
      <div className="rows padded">
        <div className="inline-form wrap">
          <select className="select" aria-label="Character to export" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Choose a character</option>{state.characters.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select>
          <button type="button" className="button primary" disabled={!ready || busy || selected === ""} onClick={() => void run(async () => { await archiveInfo(await transfer("/export", JSON.stringify({ character: selected }), { "content-type": "application/json" })); refresh(); return undefined; })}>Export and download</button>
        </div>
        <label className="button file-button">Upload an archive to import<input type="file" accept=".tar.gz,.tgz,application/gzip" disabled={!ready || busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file !== undefined) receive(file); }} /></label>
        {upload.current === null ? null : <button type="button" className="button ghost" onClick={() => upload.current?.abort()}>Stop upload</button>}
      </div>
      {error === "" ? null : <p className="form-error" role="alert">{error}</p>}
      <div className="archive-list">
        {listing?.archives.length === 0 ? <p className="settings-empty">No transfers. Exports and uploads appear here until they expire or you remove them.</p> : null}
        {listing?.archives.map((archive) => { const status = archiveStatus(archive); return <div key={archive.id} className="archive" aria-label={archive.filename}>
          <div className="archive-main"><span className="setting-label mono">{archive.filename}</span><span className={`status-text ${status.tone}`}>{status.text}</span><span className="setting-description">{mib(archive.bytes)} · expires {formatTime(new Date(archive.expires_at).toISOString())}</span></div>
          <div className="actions-row tight">
            {archive.phase === "ready" ? archive.downloadable ? <button type="button" className="button primary" disabled={busy} onClick={() => download(archive)}>Download</button> : <button type="button" className="button primary" disabled={busy} onClick={() => setConfirm(archive)}>Import…</button> : null}
            {["uploading", "exporting", "importing"].includes(archive.phase) ? null : <button type="button" className="button ghost" disabled={busy} onClick={() => void run(async () => { await transfer(`/${archive.id}/remove`); refresh(); return undefined; })}>Remove</button>}
          </div>
        </div>; })}
      </div>
    </SettingsSection>
    <SettingsSection title="Using paths on the daemon’s machine" description="For archives that already live on the machine running the daemon.">
      <PathTools state={state} />
    </SettingsSection>
    {confirm === undefined ? null : <Dialog title={`Import ${confirm.filename}?`} close={() => setConfirm(undefined)}>
      <p className="form-text">Existing characters are kept. If a character with the same name exists, the import is rejected.</p>
      <div className="form-actions"><button type="button" className="button" onClick={() => setConfirm(undefined)}>Cancel</button><button type="button" className="button primary" disabled={busy} onClick={() => { const archive = confirm; setConfirm(undefined); void run(async () => { await archiveInfo(await transfer(`/${archive.id}/import`)); refresh(); await workspace.refreshNavigation().catch((failure: unknown) => toasts.show(errorText(failure), "error")); return undefined; }); }}>Import</button></div>
    </Dialog>}
  </>;
}
