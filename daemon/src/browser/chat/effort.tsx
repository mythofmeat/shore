import { useEffect, useState } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { EFFORT_MENU_EVENT } from "../app/intents.ts";
import { configAt } from "../settings_forms.ts";
import { useOperation } from "../settings/shared.tsx";
import { Menu, type MenuItem } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { toasts } from "../ui/toast.tsx";
import { errorText, workspace } from "../app/state.ts";

const EFFORT = "reasoning_effort";

export function EffortChip({ state }: { state: WorkspaceSnapshot }) {
  const settings = useOperation(state, "model_settings", {}, [state.thread, configAt(state.config, "active_model")], state.character !== null);
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    const request = () => setRequested(true);
    addEventListener(EFFORT_MENU_EVENT, request);
    return () => removeEventListener(EFFORT_MENU_EVENT, request);
  }, []);
  const detail = settings.data !== undefined && "setting_schema" in settings.data ? settings.data : undefined;
  const entry = detail?.setting_schema.find((item) => item.key === EFFORT);
  const available = detail !== undefined && entry?.applicability === "honored" && entry.suggestions.length > 0;
  const settled = !settings.loading && (detail !== undefined || settings.error !== "");
  useEffect(() => {
    if (!requested || !(available || settled)) return;
    setRequested(false);
    if (available) return;
    if (settings.error === "") toasts.show("This model has no reasoning effort setting.");
    else toasts.show(settings.error, "error");
  }, [requested, available, settled, settings.error]);
  if (!available || detail === undefined || entry === undefined) return null;
  const effective = detail.effective_sampler[EFFORT];
  const current = typeof effective === "string" ? effective : undefined;
  const choose = (value: string | null) => {
    workspace.actions.run("set_model_setting", { key: EFFORT, scope: "character", value, name: detail.model })
      .then((result) => { if (result.warning !== undefined) toasts.show(result.warning, "error"); settings.refresh(); })
      .catch((error: unknown) => toasts.show(errorText(error), "error"));
  };
  const items: MenuItem[] = [
    ...entry.suggestions.map((level) => ({ label: level, ...(level === current ? { detail: "Current" } : {}), onSelect: () => choose(level) })),
    ...(detail.saved_character?.[EFFORT] === undefined ? [] : ["separator" as const, { label: "Reset to default", onSelect: () => choose(null) }]),
  ];
  return <Menu label="Reasoning effort" items={items} align="start" placement="above" openEvent={EFFORT_MENU_EVENT} defaultOpen={requested} triggerClassName="effort-chip"
    triggerLabel={`Reasoning effort: ${current ?? "model default"}. Change reasoning effort`}
    trigger={<><span className="effort-name">Effort</span><span>{current ?? "default"}</span><Icon name="chevronUp" size={14} /></>} />;
}
