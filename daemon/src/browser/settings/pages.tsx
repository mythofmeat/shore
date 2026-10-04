import type { ComponentType } from "react";
import type { WorkspaceSnapshot } from "../workspace.ts";
import type { SettingsPage } from "../app/route.ts";
import { AppearancePage } from "./Appearance.tsx";
import { ArchivesPage } from "./Archives.tsx";
import { CharactersPage } from "./Characters.tsx";
import { ConfigurationPage } from "./Configuration.tsx";
import { DebugPage } from "./Debug.tsx";
import { DevicesPage } from "./Devices.tsx";
import { DiagnosticsPage } from "./Diagnostics.tsx";
import { KeyboardPage } from "./Keyboard.tsx";
import { MemoryPage } from "./Memory.tsx";
import { ModelsPage } from "./Models.tsx";
import { ProvidersPage } from "./Providers.tsx";
import { ToolsPage } from "./Tools.tsx";
import { TracesPage } from "./Traces.tsx";
import { UsagePage } from "./Usage.tsx";

export const SETTINGS_PAGE_VIEWS: Record<SettingsPage, ComponentType<{ state: WorkspaceSnapshot }>> = {
  models: ModelsPage, characters: CharactersPage, appearance: AppearancePage, keyboard: KeyboardPage,
  providers: ProvidersPage, usage: UsagePage, configuration: ConfigurationPage, devices: DevicesPage,
  memory: MemoryPage, diagnostics: DiagnosticsPage, traces: TracesPage, tools: ToolsPage, archives: ArchivesPage, debug: DebugPage,
};
