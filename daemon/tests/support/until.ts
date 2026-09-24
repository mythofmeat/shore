export async function until(holds: () => boolean, what: string, hangGuardMs = 10_000): Promise<void> {
  await untilAsync(() => Promise.resolve(holds()), what, hangGuardMs);
}

export async function untilAsync(
  holds: () => Promise<boolean>,
  what: string,
  hangGuardMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + hangGuardMs;
  while (!(await holds())) {
    if (performance.now() > deadline) throw new Error(`${what} never happened within ${hangGuardMs} ms`);
    await Bun.sleep(5);
  }
}
