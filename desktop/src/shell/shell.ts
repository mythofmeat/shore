import type { DesktopBridge } from "../bridge.ts";

declare global {
  interface Window { shoreDesktop?: DesktopBridge }
}

const params = new URLSearchParams(location.search);

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`The page is missing #${id}`);
  return found as T;
}

function bridge(): DesktopBridge {
  if (window.shoreDesktop === undefined) throw new Error("The desktop bridge is unavailable");
  return window.shoreDesktop;
}

function showConnect(): void {
  const form = element<HTMLFormElement>("connect");
  const input = element<HTMLInputElement>("address");
  const submit = element<HTMLButtonElement>("connect-submit");
  const error = element("connect-error");
  const report = (message: string) => { error.textContent = message; error.hidden = message === ""; };
  form.hidden = false;
  input.value = params.get("address") ?? "";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit.disabled = true;
    report("");
    void bridge().connect(input.value).then((problem) => {
      if (problem === null) return;
      submit.disabled = false;
      report(problem);
      input.focus();
    });
  });
  input.focus();
  input.select();
}

function showConnecting(): void {
  element("connecting").hidden = false;
  element("connecting-address").textContent = params.get("address") ?? "";
  element("connecting-edit").addEventListener("click", () => { bridge().edit(); });
}

function showUnreachable(): void {
  element("unreachable").hidden = false;
  element("failure-title").textContent = params.get("title") ?? "Shore couldn't load";
  element("failure-detail").textContent = params.get("detail") ?? "";
  element("failure-address").textContent = params.get("address") ?? "";
  const countdown = element("countdown");
  let remaining = Math.max(1, Number(params.get("retry")) || 5);
  const render = () => { countdown.textContent = remaining > 0 ? `Trying again in ${String(remaining)} s` : "Trying again…"; };
  const retry = () => { window.clearInterval(timer); remaining = 0; render(); bridge().retry(); };
  const timer = window.setInterval(() => { remaining -= 1; if (remaining > 0) render(); else retry(); }, 1000);
  render();
  element("retry").addEventListener("click", retry);
  element("edit").addEventListener("click", () => { window.clearInterval(timer); bridge().edit(); });
}

const view = params.get("view");
if (view === "unreachable") showUnreachable();
else if (view === "connecting") showConnecting();
else showConnect();
