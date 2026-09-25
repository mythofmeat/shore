import type { WorkspaceSnapshot } from "../workspace.ts";
import { perform, workspace } from "./state.ts";

export function Shell({ state }: { state: WorkspaceSnapshot }) {
  return <div className="shell">
    <header className="topbar"><span className="wordmark">shore</span><span className="status">{state.status === "ready" ? "Connected" : state.detail || "Connecting…"}</span>
      <button className="button" onClick={() => perform(() => workspace.connection.signOut())}>Disconnect</button></header>
  </div>;
}
