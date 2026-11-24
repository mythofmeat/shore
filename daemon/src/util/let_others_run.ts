export async function letOthersRun(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}
