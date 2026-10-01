const UNREAD = /^\((\d+)\) /;

export function unreadCount(title: string): number {
  const count = UNREAD.exec(title)?.[1];
  return count === undefined ? 0 : Number(count);
}
