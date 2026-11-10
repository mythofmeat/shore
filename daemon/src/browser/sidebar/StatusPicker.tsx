import { useCallback, useEffect, useState } from "react";
import type { PresenceArgs } from "../../protocol/PresenceArgs.ts";
import type { PresenceResult } from "../../protocol/PresenceResult.ts";
import { Menu, type MenuItem } from "../ui/controls.tsx";

export function StatusPicker({ ready, ask, failed }: {
  ready: boolean;
  ask: (args: PresenceArgs) => Promise<PresenceResult>;
  failed: (error: unknown) => void;
}) {
  const [presence, setPresence] = useState<PresenceResult | null>(null);
  const load = useCallback((args: PresenceArgs) => { ask(args).then(setPresence).catch(failed); }, [ask, failed]);
  useEffect(() => {
    if (!ready) return;
    const refresh = () => { load({}); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); };
  }, [ready, load]);
  if (presence === null) return null;
  const current = presence.status;
  if (current === undefined && presence.choices.length === 0) return null;
  const choices = presence.choices.map((choice): MenuItem => ({ label: choice, ...(choice === current ? { detail: "Set" } : {}), onSelect: () => { load({ status: choice }); } }));
  const clear: MenuItem[] = current === undefined ? [] : ["separator", { label: "Clear status", onSelect: () => { load({ status: "" }); } }];
  return <Menu label="Your status" items={[...choices, ...clear]} trigger={<span className="status-chip">{current ?? "Set status"}</span>} triggerLabel="Your status" triggerClassName="chip" align="start" placement="above" />;
}
