import { useEffect } from "react";
import { SignIn } from "./SignIn.tsx";
import { Shell } from "./Shell.tsx";
import { useWorkspace, workspace } from "./state.ts";

export function App() {
  const state = useWorkspace();
  useEffect(() => { workspace.connection.connect(); return () => { workspace.connection.stop(); }; }, []);
  if (state.status === "signed_out" || state.status === "stopped") return <SignIn detail={state.detail} />;
  return <Shell state={state} />;
}
