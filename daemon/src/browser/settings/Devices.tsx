import { useCallback, useEffect, useState } from "react";
import type { WebDevice } from "../../protocol/WebDevice.ts";
import type { WebDeviceList } from "../../protocol/WebDeviceList.ts";
import type { WebLoginCode } from "../../protocol/WebLoginCode.ts";
import type { WebNewDevice } from "../../protocol/WebNewDevice.ts";
import type { ChromeSnapshot } from "../workspace.ts";
import { copyText } from "../clipboard.ts";
import { deviceOrigin, loginLink, loopbackOrigin } from "../login_link.ts";
import { useStoredText } from "../ui/hooks.ts";
import { QrCode } from "../ui/qr.tsx";
import { workspace } from "../app/state.ts";
import { SettingRow, SettingsSection } from "./layout.tsx";
import { useAction } from "./shared.tsx";

const ADDRESS_KEY = "shore.device-address";
const ADDRESS_HINT = "Enter an address such as my-computer:7340 or https://my-computer.example.";
const KINDS: Record<WebDevice["kind"], string> = { browser: "Browser", cli: "Command line", automation: "Automation key" };

export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

export function lastUsed(at: number | undefined, now: number): string {
  if (at === undefined || at === 0) return "not used yet";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "used just now";
  if (minutes < 60) return `used ${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `used ${String(hours)} h ago`;
  return `used ${new Date(at).toLocaleDateString()}`;
}

export function deviceDetail(device: WebDevice, now: number): string {
  const kind = device.operations === undefined ? KINDS[device.kind] : `${KINDS[device.kind]} for ${device.operations.join(", ")}`;
  return `${kind} · ${lastUsed(device.last_used_at, now)}`;
}

function SignInCode() {
  const [address, setAddress] = useStoredText(ADDRESS_KEY, () => loopbackOrigin(location.origin) ? "" : location.origin);
  const [code, setCode] = useState<WebLoginCode>();
  const [now, setNow] = useState(() => Date.now());
  const { busy, run } = useAction();
  useEffect(() => {
    if (code === undefined) return;
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [code]);
  const origin = deviceOrigin(address);
  const live = code !== undefined && code.expires_at > now ? code : undefined;
  const shown = origin === undefined || live === undefined ? undefined : { link: loginLink(origin, live.code), left: live.expires_at - now };
  const show = () => void run(async () => { const created = await workspace.connection.loginCode(); setNow(Date.now()); setCode(created); return undefined; });
  return <SettingsSection title="Sign in a browser" description="Open this on the phone or computer to sign in. Each code works once and expires after five minutes.">
    <div className="rows padded">
      <label className="field">
        <span>Address the other device opens</span>
        <input className="input mono" value={address} placeholder="my-computer:7340" spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => setAddress(event.target.value)} />
      </label>
      {address.trim() !== "" && origin === undefined ? <p className="form-error" role="alert">{ADDRESS_HINT}</p> : null}
      {origin !== undefined && loopbackOrigin(origin) ? <p className="setting-description">{origin} only reaches this computer. Enter an address the other device can reach, such as this computer’s network or tailnet name.</p> : null}
      <div className="actions-row tight"><button type="button" className="button primary" disabled={busy || origin === undefined} onClick={show}>{code === undefined ? "Show sign-in code" : "New code"}</button></div>
      {shown !== undefined ? <div className="login-code">
        <QrCode text={shown.link} label="Sign-in code" />
        <div className="login-code-text">
          <p className="setting-description">Scan this with the other device’s camera, or open the link there.</p>
          <code className="login-code-link">{shown.link}</code>
          <div className="actions-row tight"><button type="button" className="button" onClick={() => void run(async () => { await copyText(shown.link); return "Link copied"; })}>Copy link</button></div>
          <p className="setting-description">Expires in {countdown(shown.left)}</p>
        </div>
      </div> : code !== undefined && live === undefined ? <p className="setting-description">That code expired. Show a new one.</p> : null}
    </div>
  </SettingsSection>;
}

function NewKey({ state, made }: { state: ChromeSnapshot; made: () => void }) {
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [key, setKey] = useState<WebNewDevice>();
  const { busy, run } = useAction();
  const offered = [...state.requests, ...state.operations].filter((operation) => !["switch_character", "switch_thread"].includes(operation.name));
  const toggle = (operation: string, on: boolean) => { setChosen((current) => on ? [...current, operation] : current.filter((item) => item !== operation)); };
  const create = () => void run(async () => {
    setKey(await workspace.connection.automationKey(name, chosen));
    setName(""); setChosen([]); made();
    return undefined;
  });
  return <SettingsSection title="New automation key" description="For a phone shortcut, Home Assistant or a script. The key can run only the operations you tick, and is shown once.">
    <div className="rows padded">
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} placeholder="Phone shortcuts" onChange={(event) => setName(event.target.value)} />
      </label>
      <fieldset className="field key-operations">
        <legend>Operations it may run</legend>
        {offered.map((operation) => <label key={operation.name} className="check">
          <input type="checkbox" checked={chosen.includes(operation.name)} onChange={(event) => toggle(operation.name, event.target.checked)} />
          {operation.label} <code>{operation.name}</code>
        </label>)}
      </fieldset>
      <div className="actions-row tight"><button type="button" className="button primary" disabled={busy || name.trim() === "" || chosen.length === 0} onClick={create}>Make key</button></div>
      {key === undefined ? null : <div className="new-key" role="status">
        <p className="setting-description">Copy the key for {key.device.name} now; it isn’t shown again. Send it as <code>Authorization: Bearer</code>, for example:</p>
        <pre className="key-example">{`curl -X POST ${location.origin}/api/op/${key.device.operations?.[0] ?? "presence"} \\\n  -H "Authorization: Bearer ${key.token}" \\\n  -H "Content-Type: application/json" -d '{}'`}</pre>
        <div className="actions-row tight"><button type="button" className="button" onClick={() => void run(async () => { await copyText(key.token); return "Key copied"; })}>Copy key</button>
          <button type="button" className="button" onClick={() => setKey(undefined)}>Done</button></div>
      </div>}
    </div>
  </SettingsSection>;
}

export function DevicesPage({ state }: { state: ChromeSnapshot }) {
  const [list, setList] = useState<WebDeviceList>();
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const { busy, run } = useAction();
  const refresh = useCallback(() => {
    workspace.connection.devices().then((devices) => { setList(devices); setNow(Date.now()); setError(""); }, (failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)); });
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => { clearInterval(timer); };
  }, [refresh]);
  const decide = (code: string, allow: boolean) => void run(async () => { await workspace.connection.decideSignIn(code, allow); refresh(); return allow ? "Signed in" : "Refused"; });
  const revoke = (device: WebDevice) => void run(async () => {
    await workspace.connection.revokeDevice(device.id);
    refresh();
    return `${device.name} is signed out`;
  });
  return <>
    <p className="settings-description">Every browser, command line and automation key that can reach this daemon. Sign any of them out here.</p>
    {list !== undefined && list.requests.length > 0 ? <SettingsSection title="Waiting to sign in" description="Allow only a code you can see on your own device.">
      <div className="rows">{list.requests.map((request) => <SettingRow key={request.code} label={<>{request.name} <code>{request.code}</code></>} description={`Expires in ${countdown(request.expires_at - now)}`}>
        <div className="actions-row tight"><button type="button" className="button primary" disabled={busy} onClick={() => decide(request.code, true)}>Allow</button>
          <button type="button" className="button" disabled={busy} onClick={() => decide(request.code, false)}>Refuse</button></div>
      </SettingRow>)}</div>
    </SettingsSection> : null}
    <SettingsSection title="Signed in" description={<>To sign in a command line, run <code>shore sign-in {location.origin}</code> there and allow the code it shows.</>}>
      {error !== "" ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="rows">{(list?.devices ?? []).map((device) => <SettingRow key={device.id} label={<>{device.name}{device.current ? <span className="device-current"> · this one</span> : null}</>} description={deviceDetail(device, now)}>
        <button type="button" className="button" disabled={busy} onClick={() => revoke(device)}>Sign out</button>
      </SettingRow>)}</div>
    </SettingsSection>
    <SignInCode />
    <NewKey state={state} made={refresh} />
  </>;
}
