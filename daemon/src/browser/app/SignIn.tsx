import { useState } from "react";
import { enteredCode } from "../login_link.ts";
import { workspace } from "./state.ts";

export function SignIn({ detail }: { detail: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try { await workspace.connection.signIn(enteredCode(code), "That code has expired or was already used. Show a new one."); setCode(""); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const message = error || (detail === "Connection stopped" ? "" : detail);
  return <main className="signin">
    <form className="signin-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <span className="wordmark">shore</span>
      <div>
        <h1>Connect to your daemon</h1>
        <p className="signin-hint">Open a sign-in link from Settings › Devices on a device that’s already signed in. On the daemon’s own machine, <code>shore devices link</code> prints one.</p>
      </div>
      <label className="field">
        <span>Sign-in code or link</span>
        <input className="input" type="text" name="code" autoComplete="one-time-code" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoFocus value={code} onChange={(event) => setCode(event.target.value)} />
      </label>
      <button className="button primary block" type="submit" disabled={busy || code.trim() === ""}>{busy ? "Connecting…" : "Connect"}</button>
      {message === "" ? null : <p className="signin-error" role="alert">{message}</p>}
    </form>
  </main>;
}
