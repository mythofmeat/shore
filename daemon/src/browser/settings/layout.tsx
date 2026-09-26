import type { ReactNode } from "react";

export function SettingsSection({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return <section className="settings-section">
    <div className="settings-section-head"><div><h2>{title}</h2>{description === undefined ? null : <p className="settings-description">{description}</p>}</div>{actions}</div>
    {children}
  </section>;
}

export function SettingRow({ label, description, children, htmlFor }: { label: ReactNode; description?: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return <div className="setting-row">
    <div className="setting-text">{htmlFor === undefined ? <div className="setting-label">{label}</div> : <label className="setting-label" htmlFor={htmlFor}>{label}</label>}{description === undefined ? null : <div className="setting-description">{description}</div>}</div>
    {children === undefined ? null : <div className="setting-control">{children}</div>}
  </div>;
}
