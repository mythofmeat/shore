import { useRef, useState, type MouseEvent, type PointerEvent } from "react";

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

export interface RowMenu {
  at: { x: number; y: number } | null;
  close: () => void;
  openFrom: (event: MouseEvent<HTMLElement>) => void;
  swallowClick: () => boolean;
  handlers: {
    onContextMenu: (event: MouseEvent<HTMLElement>) => void;
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
}

export function useRowMenu(): RowMenu {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const pressed = useRef(false);
  const release = () => { if (press.current !== null) clearTimeout(press.current.timer); };
  return {
    at,
    close: () => setAt(null),
    openFrom: (event) => {
      const box = event.currentTarget.getBoundingClientRect();
      setAt({ x: box.left, y: box.bottom + 4 });
    },
    swallowClick: () => {
      const swallow = pressed.current;
      pressed.current = false;
      return swallow;
    },
    handlers: {
      onContextMenu: (event) => {
        event.preventDefault();
        release();
        const box = event.currentTarget.getBoundingClientRect();
        setAt(event.clientX === 0 && event.clientY === 0 ? { x: box.left + 24, y: box.bottom } : { x: event.clientX, y: event.clientY });
      },
      onPointerDown: (event) => {
        if (event.pointerType !== "touch") return;
        const { clientX: x, clientY: y } = event;
        pressed.current = false;
        release();
        press.current = { x, y, timer: setTimeout(() => { pressed.current = true; setAt({ x, y }); }, LONG_PRESS_MS) };
      },
      onPointerMove: (event) => {
        if (press.current !== null && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > LONG_PRESS_SLOP) release();
      },
      onPointerUp: release,
      onPointerCancel: release,
    },
  };
}
