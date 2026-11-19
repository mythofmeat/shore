const RECLAIMABLE = new Set(["active_file", "inactive_file"]);

export function unreclaimable(current: number, stat: string): number {
  let reclaimable = 0;
  for (const line of stat.split("\n")) {
    const [key = "", value = "0"] = line.split(" ");
    if (RECLAIMABLE.has(key)) reclaimable += Number(value);
  }
  return current - reclaimable;
}
