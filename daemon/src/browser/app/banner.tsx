import { useEffect, useState } from "react";
import type { WebSignInRequest } from "../../protocol/WebSignInRequest.ts";
import { toasts } from "../ui/toast.tsx";
import type { ChromeSnapshot } from "../workspace.ts";
import { workspace } from "./state.ts";

export function ConnectionBanner({ state }: { state: ChromeSnapshot }) {
  if (state.status === "ready") return <SignInRequestBanner />;
  if (state.status === "reload_required") return <div className="banner" role="status">Shore was updated. <button type="button" className="button" onClick={() => location.reload()}>Reload</button></div>;
  return <div className="banner" role="status">{state.status === "error" ? state.detail || "Can’t reach the daemon." : "Reconnecting…"}
    <button type="button" className="button" onClick={() => workspace.connection.reconnect()}>Retry now</button></div>;
}

const SIGN_IN_POLL_MS = 5_000;

function SignInRequestBanner() {
  const [requests, setRequests] = useState<WebSignInRequest[]>([]);
  useEffect(() => {
    let stopped = false;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      workspace.connection.devices().then((list) => { if (!stopped) setRequests(list.requests); }, () => {});
    };
    check();
    const timer = setInterval(check, SIGN_IN_POLL_MS);
    document.addEventListener("visibilitychange", check);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, []);
  if (requests.length === 0) return null;
  const decide = (code: string, allow: boolean) => {
    workspace.connection.decideSignIn(code, allow).then(() => { setRequests((current) => current.filter((request) => request.code !== code)); toasts.show(allow ? "Signed in" : "Refused"); },
      (failure: unknown) => { toasts.show(failure instanceof Error ? failure.message : String(failure), "error"); });
  };
  return <>{requests.map((request) => <div key={request.code} className="banner" role="alert">
    <span>A command line on <strong>{request.name}</strong> wants to sign in, showing the code <code>{request.code}</code>.</span>
    <button type="button" className="button primary" onClick={() => decide(request.code, true)}>Allow</button>
    <button type="button" className="button" onClick={() => decide(request.code, false)}>Refuse</button>
  </div>)}</>;
}
