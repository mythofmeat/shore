import type { WorkspaceSnapshot } from "../workspace.ts";
import { workspace } from "./state.ts";

export function ConnectionBanner({ state }: { state: WorkspaceSnapshot }) {
  if (state.status === "ready") return null;
  if (state.status === "reload_required") return <div className="banner" role="status">Shore was updated. <button type="button" className="button" onClick={() => location.reload()}>Reload</button></div>;
  return <div className="banner" role="status">{state.status === "error" ? state.detail || "Can’t reach the daemon." : "Reconnecting…"}
    <button type="button" className="button" onClick={() => workspace.connection.reconnect()}>Retry now</button></div>;
}
