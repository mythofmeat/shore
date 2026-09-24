export type IconName = "plus" | "search" | "settings" | "palette" | "more" | "image" | "activity" | "branch" | "menu" | "close" | "send" | "attach" | "expand" | "moon" | "sun" | "monitor" | "chat" | "stop";

const paths: Record<IconName, string> = {
  plus: "M12 5v14M5 12h14",
  search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  settings: "m9 3-.8 3-2.9.8L3 9l2.2 2.2v1.6L3 15l2.3 2.2 2.9.8.8 3h6l.8-3 2.9-.8L21 15l-2.2-2.2v-1.6L21 9l-2.3-2.2-2.9-.8L15 3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  palette: "M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2a4 4 0 0 0 4-4C21 6 17 3 12 3ZM7 10h.01M10 7h.01M15 7h.01M17 10h.01",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  image: "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM3 16l5-5 4 4 3-3 6 6M16 7h.01",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  branch: "M6 6v12M6 12h7a5 5 0 0 0 5-5V5M4 3h4v4H4ZM4 17h4v4H4ZM16 2h4v4h-4Z",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  stop: "M6 6h12v12H6Z",
  send: "M12 19V5m-6 6 6-6 6 6",
  attach: "m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2",
  expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
  moon: "M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10",
  sun: "M12 3V1m0 22v-2M3 12H1m22 0h-2M5 5 3 3m16 16 2 2M5 19l-2 2M19 5l2-2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0",
  monitor: "M3 3h18v14H3ZM12 17v4m-4 0h8",
  chat: "M21 11a8 8 0 0 1-8 8H8l-5 3V5a2 2 0 0 1 2-2h8a8 8 0 0 1 8 8",
};

export function Icon({ name }: { name: IconName }) {
  return <svg className="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
