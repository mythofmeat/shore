import { useEffect, useState } from "react";
import { workspace } from "./state.ts";

const said = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure);

export function SignIn({ detail }: { detail: string }) {
  const [passwordSet, setPasswordSet] = useState<boolean>();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    workspace.connection.signInState().then((state) => { setPasswordSet(state.password_set); }, (failure: unknown) => { setError(said(failure)); });
  }, []);
  const choosing = passwordSet === false;
  const submit = async () => {
    setBusy(true); setError("");
    try {
      if (choosing) { await workspace.connection.choosePassword(password); setPasswordSet(true); }
      await workspace.connection.signIn({ password });
      setPassword("");
    } catch (failure) { setError(said(failure)); }
    finally { setBusy(false); }
  };
  const differ = choosing && again !== "" && again !== password;
  const message = error || (detail === "Connection stopped" ? "" : detail);
  return <main className="signin">
    <form className="signin-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <span className="wordmark">shore</span>
      <div>
        <h1>{choosing ? "Choose a password" : "Sign in"}</h1>
        {choosing ? <p className="signin-hint">This daemon has no password yet. Every browser and command line signs in with the one you choose here.</p> : null}
      </div>
      <label className="field">
        <span>Password</span>
        <input className="input" type="password" name="password" autoComplete={choosing ? "new-password" : "current-password"} autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      {choosing ? <label className="field">
        <span>Type it again</span>
        <input className="input" type="password" name="again" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} />
      </label> : null}
      {differ ? <p className="signin-error" role="alert">The two passwords differ.</p> : null}
      <button className="button primary block" type="submit" disabled={busy || passwordSet === undefined || password === "" || (choosing && again !== password)}>{busy ? "Signing in…" : choosing ? "Set password and sign in" : "Sign in"}</button>
      {message === "" ? null : <p className="signin-error" role="alert">{message}</p>}
    </form>
  </main>;
}
