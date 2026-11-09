const REPOSITORY = "electron/electron";
const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000];

export interface GitHubHosts {
  readonly api: string;
  readonly web: string;
}

const GITHUB: GitHubHosts = { api: "https://api.github.com", web: "https://github.com" };

async function throughApi(hosts: GitHubHosts, version: string, file: string, auth: Record<string, string>): Promise<Response> {
  const release = await fetch(`${hosts.api}/repos/${REPOSITORY}/releases/tags/v${version}`, {
    headers: { accept: "application/vnd.github+json", ...auth },
  });
  if (!release.ok) return release;
  const { assets } = (await release.json()) as { assets: { name: string; url: string }[] };
  const asset = assets.find((candidate) => candidate.name === file);
  if (asset === undefined) return new Response(null, { status: 404 });
  return fetch(asset.url, { headers: { accept: "application/octet-stream", ...auth } });
}

export async function electronZip(
  file: string,
  version: string,
  sha256: string,
  hosts: GitHubHosts = GITHUB,
  retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
): Promise<Uint8Array> {
  const token = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"];
  const auth: Record<string, string> = token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` };
  const sources = [
    (): Promise<Response> => fetch(`${hosts.web}/${REPOSITORY}/releases/download/v${version}/${file}`),
    (): Promise<Response> => throughApi(hosts, version, file, auth),
  ];
  const failures: string[] = [];
  for (let attempt = 0; ; attempt++) {
    const source = sources[attempt % sources.length];
    if (source === undefined) break;
    try {
      const response = await source();
      if (response.status === 404) {
        failures.push("HTTP 404, no such release file");
        break;
      }
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") === sha256) return bytes;
        failures.push("the bytes don't match the checksum the electron package ships");
      } else {
        failures.push(`HTTP ${String(response.status)}`);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    const delay = retryDelaysMs[attempt];
    if (delay === undefined) break;
    await Bun.sleep(delay);
  }
  throw new Error(`Couldn't download ${file}: ${failures.join("; ")}.`);
}
