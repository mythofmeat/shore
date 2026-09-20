import { useEffect, useState } from "react";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";
import type { WebArchiveInfo } from "../protocol/WebArchiveInfo.ts";
import type { WebArchiveList } from "../protocol/WebArchiveList.ts";
import { validWebArchiveInfo, validWebArchiveList } from "./validators.generated.js";
import { Inspect, Modal } from "./components.tsx";

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString("en-US", { maximumFractionDigits: 2 })} MiB`;

async function transfer(path: string, body?: BodyInit, headers?: HeadersInit, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`/api/archives${path}`, { method: "POST", credentials: "same-origin", ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }), signal: signal ?? AbortSignal.timeout(60_000) });
  if (!response.ok) {
    const problem: unknown = await response.json().catch(() => null);
    throw new Error(problem !== null && typeof problem === "object" && "message" in problem && typeof problem.message === "string" ? problem.message : "Archive transfer failed");
  }
  return response;
}

async function archiveInfo(response: Response): Promise<WebArchiveInfo> {
  const value: unknown = await response.json();
  if (!validWebArchiveInfo(value)) throw new Error("Invalid archive transfer response; reload the workspace");
  return value;
}

function ArchiveStatus({ archive }: { archive: WebArchiveInfo }) {
  switch (archive.phase) {
    case "uploading": return <p role="status">Uploading archive…</p>;
    case "exporting": return <p role="status">Preparing export…</p>;
    case "importing": return <p role="status">Importing archive… Keep the transfer listed while its outcome is checked.</p>;
    case "ready": return <p>{archive.downloadable ? "Export ready to download." : "Uploaded and ready to import."}</p>;
    case "imported": return <p>Import completed{archive.result?.name === "import_character" ? ` for ${archive.result.data.character}` : ""}. Temporary upload removed.</p>;
    case "failed": return <p role="alert" className="error">{archive.error ?? "Archive operation failed"}</p>;
    case "uncertain": return <p role="alert" className="error">The import outcome is uncertain. Check the character list and its history before trying again. This import will not be repeated automatically. {archive.error}</p>;
  }
}

export function Archives({ operations, characters, character, ready, changed, close, advanced }: {
  operations: OperationDescriptor[]; characters: readonly { name: string }[]; character: string | null; ready: boolean;
  changed: () => Promise<unknown>; close: () => void; advanced: (name: string, args?: Record<string, unknown>) => void;
}) {
  const [listing, setListing] = useState<WebArchiveList>();
  const [selected, setSelected] = useState(character ?? "");
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<WebArchiveInfo>();
  const [upload, setUpload] = useState<AbortController>();
  const [notice, setNotice] = useState("");
  const supported = operations.some((item) => item.name === "import_character" && item.available !== false);
  const refresh = async () => {
    const value: unknown = await (await transfer("/list")).json();
    if (!validWebArchiveList(value)) throw new Error("Invalid archive transfer list; reload the workspace");
    setListing(value);
  };
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value: unknown = await (await transfer("/list")).json();
        if (!validWebArchiveList(value)) throw new Error("Invalid archive transfer list; reload the workspace");
        if (current) { setListing(value); setConnectionError(""); }
      } catch (failure) { if (current) setConnectionError(failure instanceof Error ? failure.message : String(failure)); }
      finally { if (current) timer = setTimeout(() => { void poll(); }, 1000); }
    };
    if (ready) void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [ready]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(""); setNotice("");
    try { await work(); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const receive = async (file: File) => {
    if (listing === undefined || file.size > listing.max_upload_bytes) throw new Error(`Choose an archive no larger than ${mib(listing?.max_upload_bytes ?? 0)}`);
    const controller = new AbortController(); setUpload(controller);
    try {
      await archiveInfo(await transfer("", file, { "content-type": "application/octet-stream", "x-shore-filename": encodeURIComponent(file.name) }, controller.signal));
      setNotice("Upload complete. Review the archive before importing.");
    } finally { setUpload(undefined); }
  };
  const download = async (archive: WebArchiveInfo) => {
    const response = await transfer(`/${archive.id}/download`);
    const blob = await response.blob();
    if (blob.size !== archive.bytes) throw new Error("Archive download was incomplete; prepare another export");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = archive.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice(`Downloaded ${archive.filename}. The temporary export was removed.`);
  };
  return <Modal title="Character archives" close={close}><p>Move a character between Shore installations using a file on this computer. Archives include its configuration, workspace, history, media, usage and stored diagnostics.</p>
    {!ready ? <p role="status">Reconnect to check transfer outcomes. Imports are not automatically repeated.</p> : null}
    {!supported ? <p>Character archives are unavailable on this daemon.</p> : null}
    {listing === undefined ? null : <p className="muted">Upload/download limit: {mib(listing.max_upload_bytes)}. Processing limit: {mib(listing.max_expanded_bytes)}, including the database snapshot. Browser transfers support regular files and directories.</p>}
    <fieldset disabled={!ready || !supported || busy || listing === undefined}><legend>Import from this computer</legend><label className="field">Archive file<input type="file" accept=".tar.gz,.tgz,application/gzip" onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) void run(() => receive(file)); event.target.value = ""; }} /></label></fieldset>
    {upload === undefined ? null : <button onClick={() => upload.abort()}>Stop upload</button>}
    <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await archiveInfo(await transfer("/export", JSON.stringify({ character: selected }), { "content-type": "application/json" })); }); }}><fieldset disabled={!ready || !supported || busy}><legend>Export to this computer</legend><label className="field">Character to export<select aria-label="Character to export" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Choose a character</option>{characters.map((item) => <option key={item.name}>{item.name}</option>)}</select></label><button disabled={selected === ""} type="submit">Prepare archive</button></fieldset></form>
    {error === "" ? null : <p role="alert" className="error">{error}</p>}{connectionError === "" ? null : <p role="alert" className="error">{connectionError}</p>}{notice === "" ? null : <p role="status">{notice}</p>}
    <section aria-label="Archive transfers"><h3>Archive transfers</h3><p className="muted">Transfer outcomes belong to this sign-in and survive reconnects and daemon restarts until expiry. A restart removes temporary files and marks unfinished imports uncertain. Signing out removes your transfers.</p>{listing?.archives.length === 0 ? <p>No archive transfers.</p> : null}
      {listing?.archives.map((archive) => <article className="provider-card" key={archive.id} aria-label={archive.filename}><h4>{archive.filename}</h4><ArchiveStatus archive={archive} /><p>{mib(archive.bytes)} · expires {new Date(archive.expires_at).toLocaleString()}</p><div className="actions">
        {archive.phase === "ready" ? archive.downloadable ? <button disabled={!ready || busy} onClick={() => { void run(() => download(archive)); }}>Download archive</button> : <button disabled={!ready || busy} onClick={() => setConfirm(archive)}>Import archive</button> : null}
        {!["uploading", "exporting", "importing"].includes(archive.phase) ? <button disabled={!ready || busy} onClick={() => { void run(async () => { await transfer(`/${archive.id}/remove`); }); }}>Remove transfer</button> : null}
        {archive.phase === "imported" || archive.phase === "uncertain" ? <button onClick={() => { void run(changed); }}>Refresh characters</button> : null}
      </div><Inspect value={archive} label="Complete archive transfer" /></article>)}
    </section>
    {confirm === undefined ? null : <section className="confirmation"><h3>Confirm archive import</h3><p>Import {confirm.filename} into this daemon. Existing characters will be preserved. External memory is queued for rebuild when retain is enabled.</p><div className="actions"><button disabled={busy} onClick={() => setConfirm(undefined)}>Go back</button><button disabled={busy || !ready} onClick={() => { const archive = confirm; setConfirm(undefined); void run(async () => { await archiveInfo(await transfer(`/${archive.id}/import`)); }); }}>Confirm import</button></div></section>}
    <div className="actions"><button disabled={!ready || busy} onClick={() => { void run(refresh); }}>Refresh transfers</button><button disabled={!ready || !supported} onClick={() => advanced("import_character")}>Import from daemon path</button><button disabled={!ready || !supported} onClick={() => advanced("export_character", selected === "" ? {} : { character: selected })}>Export to daemon path</button><button disabled={!ready || !supported} onClick={() => advanced("delete_character", selected === "" ? {} : { character: selected })}>Delete character…</button></div>
  </Modal>;
}
