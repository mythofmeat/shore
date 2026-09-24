export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard !== undefined) return navigator.clipboard.writeText(text);
  const focused = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.className = "sr-only";
  document.body.append(input);
  try {
    input.select();
    // oxlint-disable-next-line typescript/no-deprecated -- The Clipboard API is unavailable on HTTP LAN origins.
    if (!document.execCommand("copy")) throw new Error("Copy is unavailable in this browser. Select the message text to copy it.");
  } finally {
    input.remove();
    if (focused instanceof HTMLElement) focused.focus();
  }
}
