import { useEffect, useRef, useState } from "react";
import type { OperationResult } from "../../operations/types.ts";
import type { ChromeSnapshot } from "../workspace.ts";
import { EFFORT_MENU_EVENT } from "../app/intents.ts";
import { configAt } from "../settings_forms.ts";
import { useOperation } from "../settings/shared.tsx";
import { Menu, type MenuItem } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { toasts } from "../ui/toast.tsx";
import { errorText, workspace } from "../app/state.ts";

const EFFORT = "reasoning_effort";

let lastDetail: { character: string | null; detail: Extract<OperationResult<"model_settings">, { setting_schema: unknown }> } | undefined;

export function EffortChip({ state }: { state: ChromeSnapshot }) {
  const settings = useOperation(state, "model_settings", {}, [state.thread, configAt(state.config, "active_model")], state.character !== null);
  const [requested, setRequested] = useState(false);
  const [pending, setPending] = useState<{ value: string | null } | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    const request = () => setRequested(true);
    addEventListener(EFFORT_MENU_EVENT, request);
    return () => removeEventListener(EFFORT_MENU_EVENT, request);
  }, []);
  const fresh = settings.data !== undefined && "setting_schema" in settings.data ? settings.data : undefined;
  if (fresh !== undefined) lastDetail = { character: state.character, detail: fresh };
  const detail = fresh ?? (settings.error === "" && lastDetail?.character === state.character ? lastDetail.detail : undefined);
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
  const saved = typeof effective === "string" ? effective : undefined;
  const current = pending === null ? saved : pending.value ?? undefined;
  const choose = (value: string | null) => {
    const attempt = ++latest.current;
    setPending({ value });
    void (async () => {
      try {
        const result = await workspace.actions.run("set_model_setting", { key: EFFORT, scope: "character", value, name: detail.model });
        if (result.warning !== undefined) toasts.show(result.warning, "error");
        if (attempt === latest.current) await settings.reload();
      } catch (error) { toasts.show(errorText(error), "error"); }
      finally { if (attempt === latest.current) setPending(null); }
    })();
  };
  const items: MenuItem[] = [
    ...entry.suggestions.map((level) => ({ label: level, ...(level === current ? { detail: "Current" } : {}), onSelect: () => choose(level) })),
    ...(detail.saved_character?.[EFFORT] === undefined ? [] : ["separator" as const, { label: "Reset to default", onSelect: () => choose(null) }]),
  ];
  return <Menu label="Reasoning effort" items={items} align="start" placement="above" openEvent={EFFORT_MENU_EVENT} defaultOpen={requested} triggerClassName={`effort-chip ${pending === null ? "" : "pending"}`}
    triggerLabel={`Reasoning effort: ${current ?? "model default"}${pending === null ? "" : ", saving"}. Change reasoning effort`}
    trigger={<><span className="effort-name">Effort</span><span>{current ?? "default"}</span>{pending === null ? <Icon name="chevronUp" size={14} /> : <span className="spinner chip-spinner" aria-hidden="true" />}</>} />;
}
