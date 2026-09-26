import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "./icons.tsx";

export function IconButton({ icon, label, size = 18, className = "", ...props }: { icon: IconName; label: string; size?: number } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label">) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}><Icon name={icon} size={size} /></button>;
}

export type MenuItem = { label: string; icon?: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean; detail?: string } | "separator";

export function Menu({ label, items, trigger, triggerLabel, triggerClassName = "icon-button", align = "end", placement = "below", openEvent, icon = "more" }: {
  label: string; items: readonly MenuItem[]; trigger?: ReactNode; triggerLabel?: string; triggerClassName?: string; align?: "start" | "end"; placement?: "below" | "above"; openEvent?: string; icon?: IconName;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (openEvent === undefined) return;
    const show = () => setOpen(true);
    addEventListener(openEvent, show);
    return () => removeEventListener(openEvent, show);
  }, [openEvent]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const move = (step: number) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons.at((index + step + buttons.length) % buttons.length)?.focus();
  };
  return <div className="menu" ref={root} onKeyDown={(event) => {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); root.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
    if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
  }}>
    <button type="button" className={triggerClassName} aria-label={triggerLabel ?? (trigger === undefined ? label : undefined)} title={triggerLabel ?? (trigger === undefined ? label : undefined)} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      {trigger ?? <Icon name={icon} />}
    </button>
    {open ? <div className={`menu-list align-${align} ${placement}`} role="menu" id={id} aria-label={label} ref={list}>
      {items.map((item, index) => item === "separator" ? <div key={index} className="menu-separator" role="separator" /> :
        <button key={index} type="button" role="menuitem" className={item.danger === true ? "danger" : ""} disabled={item.disabled} onClick={() => { setOpen(false); item.onSelect(); }}>
          {item.icon === undefined ? null : <Icon name={item.icon} size={16} />}<span className="menu-label">{item.label}</span>{item.detail === undefined ? null : <span className="menu-detail">{item.detail}</span>}
        </button>)}
    </div> : null}
  </div>;
}

export function Dialog({ title, close, children, footer, wide = false, describedBy }: { title: string; close: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; describedBy?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);
  return <dialog ref={ref} className={`dialog ${wide ? "wide" : ""}`} aria-labelledby={titleId} aria-describedby={describedBy} onCancel={(event) => { event.preventDefault(); close(); }}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-body">
      <header className="dialog-header"><h2 id={titleId}>{title}</h2><IconButton icon="close" label="Close" onClick={close} /></header>
      {children}
      {footer === undefined ? null : <footer className="dialog-footer">{footer}</footer>}
    </div>
  </dialog>;
}

export function Switch({ checked, change, label, disabled = false }: { checked: boolean; change: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => change(!checked)}><span /></button>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}
