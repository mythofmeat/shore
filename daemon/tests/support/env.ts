const saved = new Map<string, string | undefined>();

function remember(name: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
}

export function setTestEnv(name: string, value: string): void {
  remember(name);
  process.env[name] = value;
}

export function unsetTestEnv(name: string): void {
  remember(name);
  delete process.env[name];
}

export function restoreTestEnv(): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
}
