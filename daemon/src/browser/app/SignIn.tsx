import { useState } from "react";
import { workspace } from "./state.ts";

export function SignIn({ detail }: { detail: string }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try { await workspace.connection.signIn(token); setToken(""); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const message = error || (detail === "Connection stopped" ? "" : detail);
  return <main className="signin">
    <form className="signin-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <span className="wordmark">shore</span>
      <div>
        <h1>Connect to your daemon</h1>
        <p className="signin-hint">Use the same access token as the CLI, or open a sign-in link from Settings › Devices on a device that’s already signed in.</p>
      </div>
      <input className="sr-only" type="text" name="username" autoComplete="username" value="shore" readOnly tabIndex={-1} aria-hidden="true" />
      <label className="field">
        <span>Access token</span>
        <input className="input" type="password" name="password" autoComplete="current-password" autoFocus value={token} onChange={(event) => setToken(event.target.value)} />
      </label>
      <button className="button primary block" type="submit" disabled={busy || token === ""}>{busy ? "Connecting…" : "Connect"}</button>
      {message === "" ? null : <p className="signin-error" role="alert">{message}</p>}
    </form>
  </main>;
}
