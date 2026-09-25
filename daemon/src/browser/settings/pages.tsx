import type { ComponentType } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import type { SettingsPage } from "../app/route.ts";
import { AppearancePage } from "./Appearance.tsx";

function Pending(_: { state: WorkspaceSnapshot }) {
  return <p className="settings-description">This page isn’t available in the browser yet. The same settings are available through the <code>shore</code> CLI.</p>;
}

export const SETTINGS_PAGE_VIEWS: Record<SettingsPage, ComponentType<{ state: WorkspaceSnapshot }>> = {
  models: Pending, characters: Pending, appearance: AppearancePage, keyboard: Pending,
  providers: Pending, usage: Pending, configuration: Pending,
  memory: Pending, diagnostics: Pending, traces: Pending, tools: Pending, archives: Pending, debug: Pending,
};
