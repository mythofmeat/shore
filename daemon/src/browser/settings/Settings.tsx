import type { WorkspaceSnapshot } from "../workspace.ts";
import { IconButton } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { useMediaQuery } from "../ui/hooks.ts";
import { navigate, SETTINGS_PAGES, type SettingsPage } from "../app/route.ts";
import { perform, workspace } from "../app/state.ts";
import { ConnectionBanner } from "../app/banner.tsx";
import { SETTINGS_PAGE_VIEWS } from "./pages.tsx";

const GROUPS = ["Chat", "Daemon", "Advanced"] as const;

export function Settings({ state, page, sidebarOpen, toggleSidebar }: { state: WorkspaceSnapshot; page: SettingsPage; sidebarOpen: boolean; toggleSidebar: () => void }) {
  const narrow = useMediaQuery("(max-width: 700px)");
  const View = SETTINGS_PAGE_VIEWS[page];
  const label = SETTINGS_PAGES.find((item) => item.id === page)?.label ?? "Settings";
  const nav = <nav className="settings-nav" aria-label="Settings">
    <button type="button" className="settings-nav-item back" onClick={() => navigate({ view: "chat" })}><Icon name="back" size={16} />Back to chat</button>
    {GROUPS.map((group) => <div key={group} className="settings-nav-group" role="group" aria-label={group}>
      <div className="settings-nav-heading">{group}</div>
      {SETTINGS_PAGES.filter((item) => item.group === group).map((item) =>
        <button key={item.id} type="button" className={`settings-nav-item ${item.id === page ? "on" : ""}`} aria-current={item.id === page ? "page" : undefined} onClick={() => navigate({ view: "settings", page: item.id })}>{item.label}</button>)}
    </div>)}
    <div className="settings-nav-footer"><button type="button" className="settings-nav-item" onClick={() => perform(() => workspace.connection.signOut())}>Disconnect</button></div>
  </nav>;
  return <div className="settings">
    {!sidebarOpen || narrow ? <header className="topbar settings-topbar">
      {!sidebarOpen ? <IconButton icon={narrow ? "menu" : "panel"} label={narrow ? "Open sidebar" : "Expand sidebar"} onClick={toggleSidebar} /> : null}
      <div className="topbar-title"><span className="topbar-name">Settings</span>{narrow ? <><span className="topbar-separator">/</span><span className="topbar-thread">{label}</span></> : null}</div>
    </header> : null}
    <ConnectionBanner state={state} />
    <div className="settings-body">
      {narrow ? <details className="settings-nav-mobile"><summary>{label}<Icon name="chevronDown" size={14} /></summary>{nav}</details> : nav}
      <main className="settings-content" aria-label={label}>
        <div className="settings-page">
          <h1>{label}</h1>
          <View state={state} />
        </div>
      </main>
    </div>
  </div>;
}
