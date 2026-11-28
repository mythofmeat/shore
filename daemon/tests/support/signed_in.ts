export const TEST_PASSWORD = "test password";

const json = { "content-type": "application/json" };

export async function signedInCli(origin: string, name = "Test CLI"): Promise<string> {
  const chosen = await fetch(`${origin}/api/password`, { method: "POST", headers: json, body: JSON.stringify({ password: TEST_PASSWORD }) });
  if (chosen.status !== 204 && chosen.status !== 403) throw new Error(`choosing the test password answered ${String(chosen.status)}`);
  const signed = await fetch(`${origin}/api/sign-in`, { method: "POST", headers: json, body: JSON.stringify({ name, password: TEST_PASSWORD }) });
  if (!signed.ok) throw new Error(`signing the test CLI in answered ${String(signed.status)}: ${await signed.text()}`);
  return (await signed.json() as { token: string }).token;
}
