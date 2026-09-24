import { OperationImages } from "./operation_images.tsx";
import { useEffect, useState } from "react";
import type { WebRequestInfo } from "../protocol/WebRequestInfo.ts";
import type { WebRequestList } from "../protocol/WebRequestList.ts";
import type { Workspace } from "./workspace.ts";
import { validWebRequestList } from "./validators.generated.js";
import { Inspect, Modal } from "./components.tsx";

async function requestHistory(path: string): Promise<Response> {
  const response = await fetch(`/api/requests${path}`, { method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Could not check request outcomes. Keep unreviewed requests and try again after reconnecting.");
  return response;
}

function RequestStatus({ request }: { request: WebRequestInfo }) {
  switch (request.phase) {
    case "running": return <p role="status">Request still running in its originating tab.</p>;
    case "uncertain": return <><strong>Request outcome uncertain</strong><p>The connection ended before completion was confirmed. Check the affected conversation, settings or external effects before trying again. This request will not be repeated automatically.</p></>;
    case "completed": return <p>Request completed.</p>;
    case "failed": return <p>Request failed. Changes made before failure may remain.</p>;
    case "cancelled": return <p>Request cancelled. Changes made before cancellation may remain.</p>;
    case "superseded": return <p>Request superseded by newer work. Check the conversation for the current outcome.</p>;
  }
}

export function RequestRecovery({ workspace, ready, opened, setOpened }: { workspace: Workspace; ready: boolean; opened: boolean; setOpened: (open: boolean) => void }) {
  const [listing, setListing] = useState<WebRequestList>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const uncertain = workspace.getSnapshot().uncertain;
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value: unknown = await (await requestHistory("/list")).json();
        if (!validWebRequestList(value)) throw new Error("Invalid request history; reload the workspace.");
        if (current) {
          setListing(value); setError("");
          for (const item of workspace.getSnapshot().uncertain) {
            if (value.requests.some((request) => request.rid === item.rid)) workspace.acknowledge(item.rid);
          }
        }
      } catch (failure) { if (current) setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { if (current) timer = setTimeout(() => { void poll(); }, 1500); }
    };
    if (ready) void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [ready, refreshKey, workspace]);
  const acknowledge = async (request: WebRequestInfo) => {
    setBusy(true);
    try {
      await requestHistory(`/${request.id}/acknowledge`);
      workspace.acknowledge(request.rid);
      setRefreshKey((value) => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const records = listing?.requests ?? [];
  const interruptions = records.filter((request) => request.phase === "uncertain");
  const untracked = uncertain.filter((item) => !records.some((request) => request.rid === item.rid));
  return <>
    {error === "" ? null : <p role="alert" className="notice error">{error}</p>}
    {interruptions.length === 0 ? null : <div className="notice"><strong>Request outcome uncertain</strong><p>{interruptions.length} interrupted {interruptions.length === 1 ? "request needs" : "requests need"} review. Inspect the affected state before trying again.</p><button onClick={() => setOpened(true)}>Review request</button></div>}
    {untracked.map((item) => <div className="notice" key={item.rid}><strong>Request outcome uncertain</strong><p>The connection was interrupted in {item.selection.character} / {item.selection.thread ?? "main"}. Inspect its outcome before trying again.</p><Inspect value={item.request} label="Inspect interrupted request" /><button onClick={() => workspace.connection.reconnect()}>Refresh conversation</button><button onClick={() => workspace.acknowledge(item.rid)}>I checked the outcome</button></div>)}
    {opened ? <Modal title="Request history" close={() => setOpened(false)}><p>Changes, messages and tool runs from tabs sharing this sign-in survive reloads and daemon restarts until sign-out or expiry. Older confirmed results may be removed when history fills. Uncertain outcomes stay until reviewed.</p><p>Retained results can include tool inputs and output. For messages and regeneration, inspect the conversation. Cancellation or failure does not undo changes already made.</p>
      {listing === undefined ? <p>Waiting for request history…</p> : <p className="muted">Up to {listing.max_records} recent requests; results up to {Math.floor(listing.max_result_bytes / 1024)} KiB each.</p>}
      {records.length === 0 && listing !== undefined ? <p>No retained requests.</p> : null}
      {records.map((request) => <article className="provider-card" key={request.id} aria-label={`${request.label} request`}><h3>{request.label}</h3><RequestStatus request={request} /><p>{request.character ?? "Daemon"} / {request.thread ?? "main"} · {new Date(request.started_at).toLocaleString()} · expires {new Date(request.expires_at).toLocaleString()}</p>{request.error === undefined || request.error === null ? null : <p role="alert" className="error">{request.error.message}</p>}
        {request.result === undefined || request.result === null ? null : <><OperationImages name={request.result.name} result={request.result.data} /><Inspect value={request.result} label="Retained result" /></>}{request.result_omitted ? <p>The complete result could not be retained. Inspect the affected state or diagnostics; do not repeat a mutation just to retrieve its output.</p> : null}
        {request.phase === "running" ? null : <button disabled={!ready || busy} onClick={() => { void acknowledge(request); }}>{request.phase === "uncertain" ? "I checked the outcome" : "Dismiss request"}</button>}
      </article>)}
      <button disabled={!ready || busy} onClick={() => setRefreshKey((value) => value + 1)}>Refresh request history</button><button onClick={() => workspace.connection.reconnect()}>Refresh conversation</button>
    </Modal> : null}
  </>;
}
