import { useEffect } from "react";
import { loginCodeIn } from "../login_link.ts";
import { SignIn } from "./SignIn.tsx";
import { Shell } from "./Shell.tsx";
import { useWorkspace, workspace } from "./state.ts";

export function App() {
  const state = useWorkspace();
  useEffect(() => {
    const code = loginCodeIn(location.hash);
    if (code === undefined) workspace.connection.connect();
    else {
      history.replaceState(history.state, "", location.pathname + location.search);
      void workspace.connection.signIn(code, "This sign-in link has expired or was already used. Show a new code on a signed-in device, or enter the access token.").catch(() => {});
    }
    return () => { workspace.connection.stop(); };
  }, []);
  if (state.status === "signed_out" || state.status === "stopped") return <SignIn detail={state.detail} />;
  return <Shell state={state} />;
}
