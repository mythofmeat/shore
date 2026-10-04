import { useEffect, useState } from "react";
import type { WebLoginCode } from "../../protocol/WebLoginCode.ts";
import type { WorkspaceSnapshot } from "../workspace.ts";
import { copyText } from "../clipboard.ts";
import { deviceOrigin, loginLink, loopbackOrigin } from "../login_link.ts";
import { useStoredText } from "../ui/hooks.ts";
import { QrCode } from "../ui/qr.tsx";
import { workspace } from "../app/state.ts";
import { SettingsSection } from "./layout.tsx";
import { useAction } from "./shared.tsx";

const ADDRESS_KEY = "shore.device-address";
const ADDRESS_HINT = "Enter an address such as my-computer:7340 or https://my-computer.example.";

function countdown(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

export function DevicesPage(_: { state: WorkspaceSnapshot }) {
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
  const remaining = code === undefined ? 0 : code.expires_at - now;
  const link = origin === undefined || code === undefined || remaining <= 0 ? undefined : loginLink(origin, code.code);
  const show = () => void run(async () => { const created = await workspace.connection.loginCode(); setNow(Date.now()); setCode(created); return undefined; });
  return <>
    <p className="settings-description">Sign in a phone or another computer without typing the access token.</p>
    <SettingsSection title="Sign in another device" description="Each code works once and expires after five minutes.">
      <div className="rows padded">
        <label className="field">
          <span>Address the other device opens</span>
          <input className="input mono" value={address} placeholder="my-computer:7340" spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => setAddress(event.target.value)} />
        </label>
        {address.trim() !== "" && origin === undefined ? <p className="form-error" role="alert">{ADDRESS_HINT}</p> : null}
        {origin !== undefined && loopbackOrigin(origin) ? <p className="setting-description">{origin} only reaches this computer. Enter an address the other device can reach, such as this computer’s network or tailnet name.</p> : null}
        <div className="actions-row tight"><button type="button" className="button primary" disabled={busy || origin === undefined} onClick={show}>{code === undefined ? "Show sign-in code" : "New code"}</button></div>
        {link !== undefined ? <div className="login-code">
          <QrCode text={link} label="Sign-in code" />
          <div className="login-code-text">
            <p className="setting-description">Scan this with the other device’s camera, or open the link there.</p>
            <code className="login-code-link">{link}</code>
            <div className="actions-row tight"><button type="button" className="button" onClick={() => void run(async () => { await copyText(link); return "Link copied"; })}>Copy link</button></div>
            <p className="setting-description">Expires in {countdown(remaining)}</p>
          </div>
        </div> : code !== undefined && remaining <= 0 ? <p className="setting-description">That code expired. Show a new one.</p> : null}
      </div>
    </SettingsSection>
  </>;
}
