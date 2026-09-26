import type { ReactNode } from "react";

const stroke = (children: ReactNode, width = 1.75) => ({ children, width, fill: false });
const ICONS = {
  plus: stroke(<path d="M12 5v14M5 12h14" />),
  search: stroke(<><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>),
  panel: stroke(<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M9.5 4.5v15" /></>),
  menu: stroke(<path d="M4 7h16M4 12h16M4 17h16" />),
  close: stroke(<path d="M6 6l12 12M18 6L6 18" />),
  more: { children: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>, width: 0, fill: true },
  copy: stroke(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></>),
  edit: stroke(<><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></>),
  regenerate: stroke(<><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></>),
  branch: stroke(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9v1a4 4 0 0 1-4 4H6" /></>),
  trash: stroke(<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />),
  attach: stroke(<path d="M20 11.5l-8.3 8.3a5 5 0 0 1-7-7l8.3-8.3a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6" />),
  send: stroke(<path d="M12 19V5M6 11l6-6 6 6" />, 2.2),
  stop: { children: <rect x="6" y="6" width="12" height="12" rx="2" />, width: 0, fill: true },
  chevronDown: stroke(<path d="M6 9l6 6 6-6" />, 2),
  chevronUp: stroke(<path d="M6 15l6-6 6 6" />, 2),
  chevronLeft: stroke(<path d="M15 18l-6-6 6-6" />, 2),
  chevronRight: stroke(<path d="M9 6l6 6-6 6" />, 2),
  check: stroke(<path d="M5 12l5 5 9-10" />, 2),
  alert: stroke(<><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17.5v.01" /></>),
  terminal: stroke(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 10l3 2-3 2M12 15h5" /></>),
  home: stroke(<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z" />),
  chat: stroke(<path d="M5 5h14v10H9l-4 4z" />),
  settings: stroke(<><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>),
  back: stroke(<path d="M19 12H5M11 6l-6 6 6 6" />),
  person: stroke(<><circle cx="12" cy="8.5" r="3.5" /><path d="M5 19.5c1.2-3.2 3.8-4.8 7-4.8s5.8 1.6 7 4.8" /></>),
  image: stroke(<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="M20.5 16l-5-5-9 8.5" /></>),
  archive: stroke(<><rect x="3.5" y="4.5" width="17" height="4" rx="1" /><path d="M5 8.5V19h14V8.5M10 12h4" /></>),
  star: stroke(<path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z" />),
  download: stroke(<path d="M12 4v11M7 10l5 5 5-5M5 20h14" />),
  upload: stroke(<path d="M12 20V9M7 14l5-5 5 5M5 4h14" />),
  refresh: stroke(<><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></>),
  compact: stroke(<path d="M4 7h16M7 12h10M10 17h4" />),
  label: stroke(<><path d="M4 12V5h7l9 9-7 7z" /><circle cx="8" cy="9" r="1.2" /></>),
  info: stroke(<><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.01" /></>),
  expand: stroke(<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />),
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const icon = ICONS[name];
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    fill={icon.fill ? "currentColor" : "none"} stroke={icon.fill ? "none" : "currentColor"} strokeWidth={icon.width} strokeLinecap="round" strokeLinejoin="round">{icon.children}</svg>;
}
