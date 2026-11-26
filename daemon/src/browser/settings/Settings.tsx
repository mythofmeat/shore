import { useState } from "react";
import type { ChromeSnapshot } from "../workspace.ts";
import { IconButton } from "../ui/controls.tsx";
import { Icon } from "../ui/icons.tsx";
import { useMediaQuery } from "../ui/hooks.ts";
import { navigate, SETTINGS_PAGES, type SettingsPage } from "../app/route.ts";
import { workspace } from "../app/state.ts";
import { Form, useSubmit } from "../chat/dialogs.tsx";
import { ConnectionBanner } from "../app/banner.tsx";
import { SETTINGS_PAGE_VIEWS } from "./pages.tsx";

const GROUPS = ["Chat", "Daemon", "Advanced"] as const;

function SignOut() {
  const [asking, setAsking] = useState(false);
  const close = () => setAsking(false);
  const { busy, error, run } = useSubmit(close);
  return <>
    <button type="button" className="settings-nav-item" onClick={() => setAsking(true)}>Sign out</button>
    {asking ? <Form title="Sign out of this browser?" close={close} action="Sign out" danger busy={busy} error={error} submit={() => run(async () => { await workspace.connection.signOut(); return undefined; })}>
      <p className="form-text">To sign back in you'll need a sign-in code from a device that is still signed in (Settings › Devices), or <code>shore devices link</code> on the daemon's machine.</p>
    </Form> : null}
  </>;
}

export function Settings({ state, page, sidebarOpen, toggleSidebar }: { state: ChromeSnapshot; page: SettingsPage; sidebarOpen: boolean; toggleSidebar: () => void }) {
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
    <div className="settings-nav-footer"><SignOut /></div>
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
