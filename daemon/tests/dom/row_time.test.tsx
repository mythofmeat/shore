import { expect, jest, spyOn, test } from "bun:test";

import { useDom } from "./dom.ts";
import { acting, mount } from "./dom.ts";

useDom();

const NOW = Date.parse("2026-11-27T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("a row's time is now, minutes, hours, days or weeks ago, then the date, with the whole date and time in its tooltip", async () => {
  const { rowTime } = await import("../../src/browser/sidebar/row_time.ts");
  const text = (at: string) => rowTime(at, NOW).text;
  expect([ago(0), ago(MINUTE - 1), ago(MINUTE), ago(HOUR - 1), ago(HOUR), ago(DAY - 1), ago(DAY), ago(7 * DAY - 1), ago(7 * DAY), ago(35 * DAY - 1)].map(text))
    .toEqual(["now", "now", "1m", "59m", "1h", "23h", "1d", "6d", "1w", "4w"]);
  const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const month = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
  expect([text(ago(35 * DAY)), text("2026-01-02T12:00:00Z"), text("2025-12-31T12:00:00Z")]).toEqual([day.format(NOW - 35 * DAY), day.format(Date.parse("2026-01-02T12:00:00Z")), month.format(Date.parse("2025-12-31T12:00:00Z"))]);
  const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  expect(rowTime(ago(HOUR), NOW)).toEqual({ text: "1h", title: `Last message ${full.format(NOW - HOUR)}` });
  expect(rowTime(undefined, NOW)).toEqual({ text: "empty", title: "No messages yet" });
});

test("the shown time moves on every half minute while a row shows it, and stops once none does", async () => {
  const { useNow } = await import("../../src/browser/sidebar/row_time.ts");
  const started = spyOn(globalThis, "setInterval");
  const stopped = spyOn(globalThis, "clearInterval");
  jest.useFakeTimers();
  try {
    jest.setSystemTime(NOW);
    const seen: number[][] = [[], []];
    const Clock = ({ index }: { index: number }) => { seen[index]?.push(useNow()); return null; };
    const first = await mount(<Clock index={0} />);
    const second = await mount(<Clock index={1} />);
    expect([seen[0]?.at(-1), started.mock.calls.length]).toEqual([NOW, 1]);
    await acting(() => { jest.advanceTimersByTime(30_000); });
    expect([seen[0]?.at(-1), seen[1]?.at(-1)]).toEqual([NOW + 30_000, NOW + 30_000]);
    const timer = started.mock.results[0]?.value;
    await first.unmount();
    expect(stopped.mock.calls.some(([handle]) => handle === timer), "one row still shows the time").toBe(false);
    await acting(() => { jest.advanceTimersByTime(30_000); });
    expect(seen[1]?.at(-1)).toBe(NOW + 60_000);
    await second.unmount();
    expect(stopped.mock.calls.some(([handle]) => handle === timer)).toBe(true);
    jest.setSystemTime(NOW + 10 * MINUTE);
    const later = await mount(<Clock index={0} />);
    expect([seen[0]?.at(-1), started.mock.calls.length], "a row shown again starts from the time it is shown").toEqual([NOW + 10 * MINUTE, 2]);
    await later.unmount();
  } finally {
    jest.useRealTimers();
    started.mockRestore();
    stopped.mockRestore();
  }
});
